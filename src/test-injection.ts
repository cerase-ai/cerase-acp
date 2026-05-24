// Test-only HTTP endpoint enabled by BRIDGE_E2E_TEST=1. Lets the cerase
// repo's `tests/e2e-discord/` bats suite drive the full bridge pipeline
// (allowlist → session-manager → stream-buffer → send-queue) without
// needing real Discord traffic.
//
//   POST /_test/inject   { agent_id, user_id, text }   → 202 Accepted
//   GET  /_test/last-reply?agent_id=…&user_id=…         → { text } | 404
//
// Reply capture is keyed by `(agent_id, user_id)` — sets last seen.
// Multi-chunk replies are concatenated (with the " ⏎" continuation
// marker stripped) so the test can assert on the full reply text.

import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { makeLogger } from "./logger.js";
import type { Dispatcher } from "./dispatcher.js";

const logger = makeLogger("cerase-acp.test-injection");

export interface TestInjectionServer {
  url(): string;
  recordReply(agentId: string, userId: string, chunk: string): void;
  close(): Promise<void>;
}

export interface StartOptions {
  dispatcher: Dispatcher;
  port?: number;
  host?: string;
}

interface RecordedReply {
  parts: string[];
}

const replyKey = (agentId: string, userId: string) => `${agentId}:${userId}`;

export async function startTestInjectionServer(opts: StartOptions): Promise<TestInjectionServer> {
  const replies = new Map<string, RecordedReply>();

  const server = createServer((req, res) => {
    handleRequest(req, res, opts.dispatcher, replies).catch((err) => {
      logger.error({ err }, "unhandled error in test-injection handler");
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 7474, opts.host ?? "127.0.0.1", () => resolve());
  });

  return {
    url() {
      const addr = server.address() as AddressInfo;
      return `http://127.0.0.1:${addr.port}`;
    },
    recordReply(agentId, userId, chunk) {
      const k = replyKey(agentId, userId);
      const existing = replies.get(k) ?? { parts: [] };
      existing.parts.push(chunk);
      replies.set(k, existing);
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handleRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  dispatcher: Dispatcher,
  replies: Map<string, RecordedReply>,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "POST" && url.pathname === "/_test/inject") {
    const body = await readJsonBody(req);
    const agentId = body && typeof body === "object" ? (body as Record<string, unknown>).agent_id : undefined;
    const userId = body && typeof body === "object" ? (body as Record<string, unknown>).user_id : undefined;
    const text = body && typeof body === "object" ? (body as Record<string, unknown>).text : undefined;
    if (typeof agentId !== "string" || typeof userId !== "string" || typeof text !== "string") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "agent_id, user_id, text are required strings" }));
      return;
    }
    // Reset any previous reply for this (agent, user) so the test sees
    // only the fresh response.
    replies.delete(replyKey(agentId, userId));
    // Tests need determinism — await the full pipeline so the GET that
    // follows can read /_test/last-reply without polling. Production
    // Discord adapter (M5 wiring) does the same.
    try {
      await dispatcher.handleMessage(agentId, userId, text);
    } catch (err) {
      logger.error({ err, agentId, userId }, "inject dispatch failed");
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "dispatch failed" }));
      return;
    }
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "accepted" }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/_test/last-reply") {
    const agentId = url.searchParams.get("agent_id");
    const userId = url.searchParams.get("user_id");
    if (!agentId || !userId) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "agent_id and user_id query params required" }));
      return;
    }
    const entry = replies.get(replyKey(agentId, userId));
    if (!entry || entry.parts.length === 0) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no reply recorded" }));
      return;
    }
    const text = entry.parts.map((p) => p.replace(/ ⏎$/u, "")).join("");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text, chunks: entry.parts.length }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

async function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

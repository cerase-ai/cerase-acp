// SCHED-2 — production internal HTTP endpoint (shared-secret auth) the
// control-plane scheduled-message dispatcher POSTs to:
//
//   POST /internal/inject
//     Authorization: Bearer <CERASE_ACP_INTERNAL_SECRET>
//     { agent_id, user_id, text, surface_in_chat?, label? }  → 202
//
// It runs `dispatcher.handleMessage(agent_id, user_id, text)` as if the
// user had sent it, optionally posting a deterministic heads-up first.
// This is the productionised counterpart of the BRIDGE_E2E_TEST-gated
// /_test/inject (test-injection.ts).

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { makeLogger } from "./logger.js";
import type { Dispatcher } from "./dispatcher.js";

const logger = makeLogger("cerase-acp.internal-server");

export interface InternalServer {
  port(): number;
  close(): Promise<void>;
}

export interface InternalServerOptions {
  dispatcher: Dispatcher;
  /** Shared secret required in the Authorization: Bearer header. */
  internalSecret: string;
  port?: number;
  host?: string;
}

/** The heads-up posted before processing when surface_in_chat is set. */
export function headsUpText(body: string): string {
  // SCHED-5: the user must see exactly which scheduled message fired and
  // that the agent is taking it on. Body rendered as a code block.
  return `🕐 Ricevuto messaggio temporizzato:\n\`\`\`\n${body}\n\`\`\`\nora lo prendo in carico.`;
}

export async function startInternalServer(opts: InternalServerOptions): Promise<InternalServer> {
  const server = createServer((req, res) => {
    handleRequest(req, res, opts).catch((err) => {
      logger.error({ err }, "unhandled error in internal-server handler");
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal" });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 7476, opts.host ?? "0.0.0.0", () => resolve());
  });

  return {
    port() {
      const addr = server.address();
      return addr && typeof addr === "object" ? addr.port : (opts.port ?? 7476);
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: InternalServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method !== "POST" || url.pathname !== "/internal/inject") {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  // Shared-secret gate (cluster-only endpoint).
  const auth = req.headers.authorization ?? "";
  const expected = `Bearer ${opts.internalSecret}`;
  if (!opts.internalSecret || auth !== expected) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  const body = await readJsonBody(req);
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const agentId = rec.agent_id;
  const userId = rec.user_id;
  const text = rec.text;
  if (typeof agentId !== "string" || typeof userId !== "string" || typeof text !== "string") {
    sendJson(res, 400, { error: "agent_id, user_id, text are required strings" });
    return;
  }
  const surfaceInChat = rec.surface_in_chat !== false; // default true

  try {
    if (surfaceInChat) {
      // Deterministic heads-up before the model turn (best-effort — a
      // heads-up failure must not block the actual injection).
      try {
        await opts.dispatcher.sendSystemMessage(agentId, userId, headsUpText(text));
      } catch (err) {
        logger.warn({ err, agentId }, "heads-up send failed; continuing with injection");
      }
    }
    await opts.dispatcher.handleMessage(agentId, userId, text);
  } catch (err) {
    logger.error({ err, agentId, userId }, "scheduled inject dispatch failed");
    sendJson(res, 500, { error: "dispatch failed" });
    return;
  }

  sendJson(res, 202, { status: "accepted" });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
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

// SCHED-2 — production internal HTTP endpoint (shared-secret auth) the
// control-plane scheduled-message dispatcher POSTs to:
//
//   POST /internal/inject
//     Authorization: Bearer <CERASE_ACP_INTERNAL_SECRET>
//     { agent_id, user_id, text, surface_in_chat?, label?, system_message_only? }  → 202
//
// It runs `dispatcher.handleMessage(agent_id, user_id, text)` as if the
// user had sent it, optionally posting a deterministic heads-up first.
// E3: when `system_message_only` is true it instead delivers `text` straight
// to the DM as a system message and runs NO model turn (the E2 bind-time
// connect nudge — a notification, not a prompt the agent should answer).
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
  // E3: a notification-only injection (the E2 bind-time connect nudge) delivers
  // the text straight to the DM as a system message and must NOT run a model
  // turn — otherwise the agent would "reply" to its own nudge. When set, we send
  // `text` verbatim via sendSystemMessage and skip handleMessage entirely.
  const systemMessageOnly = rec.system_message_only === true;
  // C1-4: an optional caller-supplied heads-up overrides the default
  // scheduled-message wording (the in-admin chat echo passes its own
  // attribution marker, e.g. "💬 Paolo (dal pannello): …"). Absent → the
  // scheduled dispatcher's existing heads-up is used, so it is unaffected.
  const headsUp =
    typeof rec.heads_up === "string" && rec.heads_up.length > 0
      ? rec.heads_up
      : headsUpText(text);

  if (systemMessageOnly) {
    try {
      await opts.dispatcher.sendSystemMessage(agentId, userId, text);
    } catch (err) {
      logger.error({ err, agentId, userId }, "system-message-only inject failed");
      sendJson(res, 500, { error: "dispatch failed" });
      return;
    }
    sendJson(res, 202, { status: "accepted" });
    return;
  }

  try {
    if (surfaceInChat) {
      // Deterministic heads-up before the model turn (best-effort — a
      // heads-up failure must not block the actual injection).
      try {
        await opts.dispatcher.sendSystemMessage(agentId, userId, headsUp);
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

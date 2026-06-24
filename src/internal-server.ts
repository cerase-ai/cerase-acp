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

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Dispatcher } from "./dispatcher.js";
import { makeLogger } from "./logger.js";

const logger = makeLogger("cerase-acp.internal-server");

export interface InternalServer {
  port(): number;
  close(): Promise<void>;
}

/**
 * M-BRIDGE-LIVENESS-1 — one agent's REAL runtime state on the bridge.
 * `attached` = an adapter is held for it; `ready` = its channel client
 * reports a live connection right now (discord.js `client.isReady()`).
 * The field is channel-agnostic (`ready`, not `discordReady`): the bridge
 * is multi-channel and the control-plane maps it to a single "Connessione"
 * badge regardless of platform.
 */
export interface AgentLiveness {
  id: string;
  channel: string;
  attached: boolean;
  /**
   * `true`/`false` = the channel client reports a live/dropped connection;
   * `null` = unknown (the adapter exposes no readiness signal yet). M-ACP-HARDEN-1
   * fixed a false-green: non-Discord adapters used to report `true` unconditionally,
   * so a Slack/Telegram gateway drop showed as healthy — they now report `null`
   * (the control-plane renders "stato sconosciuto", not a green badge).
   */
  ready: boolean | null;
}

export interface InternalServerOptions {
  dispatcher: Dispatcher;
  /** Shared secret required in the Authorization: Bearer header. */
  internalSecret: string;
  port?: number;
  host?: string;
  /**
   * M-BRIDGE-LIVENESS-1 — supplies the per-agent liveness snapshot served
   * by `GET /internal/status`. Absent → the endpoint reports an empty set.
   */
  getAgentStatus?: () => AgentLiveness[];
  /**
   * M-ACP-HARDEN-1 — gate the inject endpoint on the agent's allowlist.
   * Without it, an internal-secret holder could deliver arbitrary text to
   * ANY user_id on ANY agent's channel (the model-turn path checks the
   * allowlist, but the heads-up + system-message-only sends bypassed it).
   * When provided, an inject for a (agentId,userId) not in the allowlist is
   * rejected 403 before any send. Absent → no allowlist enforcement
   * (back-compat for callers that pre-validate).
   */
  isAllowed?: (agentId: string, userId: string) => boolean;
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

async function handleRequest(req: IncomingMessage, res: ServerResponse, opts: InternalServerOptions): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  // M-ACP-HEALTHCHECK-1 — UNAUTHENTICATED liveness probe for the compose
  // healthcheck, served BEFORE the shared-secret gate. Returns 200 iff the
  // internal server is listening, so the container goes unhealthy the moment
  // the bridge's inject transport is down — unlike the old `node --version`
  // check, which stayed green all through the crash-loop. It leaks only counts
  // (never agent identities or secrets), so it needs no bearer.
  if (req.method === "GET" && url.pathname === "/healthz") {
    const payload: Record<string, unknown> = { status: "ok" };
    if (opts.getAgentStatus) {
      const agents = opts.getAgentStatus();
      payload.adapters = agents.length;
      payload.ready = agents.filter((a) => a.ready === true).length;
    }
    sendJson(res, 200, payload);
    return;
  }

  // Shared-secret gate (cluster-only endpoints) — evaluated once, applied
  // to every route below.
  const auth = req.headers.authorization ?? "";
  const expected = `Bearer ${opts.internalSecret}`;
  // M-ACP-HARDEN-1: constant-time compare so the gate doesn't leak the
  // secret's length/prefix through response timing.
  const authorized = Boolean(opts.internalSecret) && safeEqual(auth, expected);

  // M-BRIDGE-LIVENESS-1 — GET /internal/status: the per-agent runtime
  // liveness the control-plane reads to render the "Connessione" badge and
  // flag "Attivo ma disconnesso". Read-only; same shared-secret gate.
  if (req.method === "GET" && url.pathname === "/internal/status") {
    if (!authorized) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const agents = opts.getAgentStatus ? opts.getAgentStatus() : [];
    sendJson(res, 200, { agents });
    return;
  }

  if (req.method !== "POST" || url.pathname !== "/internal/inject") {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  if (!authorized) {
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
  // M-ACP-HARDEN-1: the inject endpoint must not deliver text to an arbitrary
  // user on an arbitrary agent's channel even with the internal secret.
  // Enforce the agent's allowlist here — covering BOTH the system-message-only
  // path and the heads-up + model-turn path — before any send happens.
  if (opts.isAllowed && !opts.isAllowed(agentId, userId)) {
    logger.info({ agentId, userId }, "inject rejected: user not in agent allowlist");
    sendJson(res, 403, { error: "user not allowed for this agent" });
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
  const headsUp = typeof rec.heads_up === "string" && rec.heads_up.length > 0 ? rec.heads_up : headsUpText(text);

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

/**
 * M-ACP-HARDEN-1 — constant-time string compare for the shared-secret gate.
 * `timingSafeEqual` throws on length mismatch, so guard the length first
 * (a length difference is not itself secret).
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
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

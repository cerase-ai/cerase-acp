// SCHED-2 — production internal HTTP endpoint (shared-secret auth) the
// control-plane scheduled-message dispatcher POSTs to:
//
//   POST /internal/inject
//     Authorization: Bearer <CERASE_ACP_INTERNAL_SECRET>
//     { agent_id, user_id, text, surface_in_chat?, label?, system_message_only? }  → 202
//
// It runs `dispatcher.handleMessage(agent_id, user_id, text)` as if the
// user had sent it, optionally posting a deterministic heads-up first.
// The 202 means accepted (validation + allowlist passed), not "turn
// completed" — the caller (AcpInjector) uses a 15s fire-and-forget timeout,
// and awaiting the full model turn made every >15s turn throw
// ChatInjectFailed client-side while the turn actually ran, so the scheduled
// dispatcher re-fired it (duplicate DMs). The heads-up + turn run as a logged
// background task; failures stay observable via loud logs + the `inject`
// block of GET /internal/status.
// E3: when `system_message_only` is true it instead delivers `text` straight
// to the DM as a system message and runs NO model turn (the E2 bind-time
// connect nudge — a notification, not a prompt the agent should answer);
// that path is a fast channel send, so it stays synchronous and keeps its
// truthful 500 on delivery failure.
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
 * One agent's REAL runtime state on the bridge.
 * `attached` = an adapter is held for it; `ready` = its channel client
 * reports a live connection right now (discord.js `client.isReady()`).
 * The field is channel-agnostic (`ready`, not `discordReady`): the bridge
 * is multi-channel and the control-plane maps it to a single "Connessione"
 * badge regardless of platform.
 */
/**
 * Why an agent is down, when the bridge knows and has stopped trying to fix
 * it. A retry loop against a refused credential looks like recovery in
 * progress and is not, so the stop has to be reported somewhere a person
 * looks; this block is that place.
 *
 * Both kinds share `kind` and `detail`, and a reader that shows only the
 * sentence needs nothing else. The rest of each kind names the thing to
 * change, because an operator who knows an assistant is down still has to be
 * told which value to edit and where.
 */
export type AgentFailure = CredentialRejectedFailure | SessionModeMissingFailure;

/** The channel provider refused this agent's credential. */
export interface CredentialRejectedFailure {
  kind: "credential_rejected";
  /** The provider's own error code, verbatim. */
  code: string;
  /** Which credential in agents.yaml was refused. Never its value. */
  credential: string;
  /** One line naming what a person has to do to bring the assistant back. */
  detail: string;
}

/**
 * This agent's slot does not define the session mode its assistant runs
 * under, so every session for it is refused.
 *
 * It is reported beside the credential kind because it is the same situation
 * for the reader: the assistant answers nothing and no amount of waiting
 * changes that. It looks different from every other angle, which is why it
 * needs saying here at all — the channel is connected and `ready` is `true`,
 * so nothing else in this snapshot is anything but green.
 */
export interface SessionModeMissingFailure {
  kind: "session_mode_missing";
  /** The mode the bridge asked the slot for. */
  mode: string;
  /** The modes the slot does offer. Empty is a legal and informative answer. */
  available: string[];
  /** One line naming what a person has to do to bring the assistant back. */
  detail: string;
}

export interface AgentLiveness {
  id: string;
  channel: string;
  attached: boolean;
  /**
   * `true`/`false` = the channel client reports a live/dropped connection;
   * `null` = unknown (the adapter exposes no readiness signal yet). A
   * non-Discord adapter that reported `true` unconditionally would show a
   * dropped Slack/Telegram gateway as healthy — reporting `null` instead lets
   * the control-plane render "stato sconosciuto" rather than a green badge.
   */
  ready: boolean | null;
  /**
   * Present only while the bridge is not trying to reconnect this agent
   * because the failure cannot resolve itself. Absent means either healthy or
   * a transient failure still being retried, which are different situations
   * from this one and neither of them needs an operator tonight. Additive:
   * an existing client that reads `id`, `channel`, `attached` and `ready` is
   * unaffected by it.
   */
  failure?: AgentFailure;
}

export interface InternalServerOptions {
  dispatcher: Dispatcher;
  /** Shared secret required in the Authorization: Bearer header. */
  internalSecret: string;
  port?: number;
  host?: string;
  /**
   * Supplies the per-agent liveness snapshot served
   * by `GET /internal/status`. Absent → the endpoint reports an empty set.
   */
  getAgentStatus?: () => AgentLiveness[];
  /**
   * Gate the inject endpoint on the agent's allowlist.
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

/**
 * The observable outcome of the detached inject turns,
 * served as the additive `inject` block of GET /internal/status. Because the
 * endpoint now acks 202 at acceptance, this (plus loud logs) is where a
 * failed background turn surfaces — the M-ACP-FAILLOUD guarantee that a 202
 * is never silently followed by nothing.
 */
export interface InjectActivity {
  in_flight: number;
  succeeded: number;
  failed: number;
  last_failure: { agent_id: string; user_id: string; at: string; error: string } | null;
}

/** Per-server-instance tracker behind {@link InjectActivity}. */
class InjectTracker {
  private activity: InjectActivity = { in_flight: 0, succeeded: 0, failed: 0, last_failure: null };

  start(): void {
    this.activity.in_flight += 1;
  }

  succeed(): void {
    this.activity.in_flight -= 1;
    this.activity.succeeded += 1;
  }

  fail(agentId: string, userId: string, error: unknown): void {
    this.activity.in_flight -= 1;
    this.activity.failed += 1;
    this.activity.last_failure = {
      agent_id: agentId,
      user_id: userId,
      at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
  }

  snapshot(): InjectActivity {
    return {
      ...this.activity,
      last_failure: this.activity.last_failure ? { ...this.activity.last_failure } : null,
    };
  }
}

export async function startInternalServer(opts: InternalServerOptions): Promise<InternalServer> {
  // One tracker per server instance, shared by every
  // request so /internal/status reports the aggregate detached-turn outcome.
  const injects = new InjectTracker();
  const server = createServer((req, res) => {
    handleRequest(req, res, opts, injects).catch((err) => {
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
  injects: InjectTracker,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  // An unauthenticated liveness probe for the compose healthcheck, served
  // before the shared-secret gate. Returns 200 iff the internal server is
  // listening, so the container goes unhealthy the moment the bridge's
  // inject transport is down — unlike the old `node --version` check, which
  // stayed green all through the crash-loop. It leaks only counts (never
  // agent identities or secrets), so it needs no bearer.
  if (req.method === "GET" && url.pathname === "/healthz") {
    const payload: Record<string, unknown> = { status: "ok" };
    if (opts.getAgentStatus) {
      const agents = opts.getAgentStatus();
      payload.adapters = agents.length;
      // `ready` is only meaningful for adapters that have a readiness — a web
      // agent reports `ready: null` because there is no connection to be
      // ready. Counting `=== true` over all of them makes a completely
      // healthy bridge report fewer ready than adapters, which reads as "one
      // is down" when nothing is down — a number that gets an alert wired to
      // it, and then muted.
      //
      // So the denominator is published too, over the adapters the question
      // applies to. `readyOf` is 0 on a bridge of only web agents, and
      // `ready === readyOf` is the comparison a caller should make — never
      // `ready === adapters`.
      const rateable = agents.filter((a) => a.ready !== null && a.ready !== undefined);
      payload.ready = rateable.filter((a) => a.ready === true).length;
      payload.readyOf = rateable.length;
    }
    sendJson(res, 200, payload);
    return;
  }

  // Shared-secret gate (cluster-only endpoints) — evaluated once, applied
  // to every route below.
  const auth = req.headers.authorization ?? "";
  const expected = `Bearer ${opts.internalSecret}`;
  // Constant-time compare so the gate doesn't leak the
  // secret's length/prefix through response timing.
  const authorized = Boolean(opts.internalSecret) && safeEqual(auth, expected);

  // GET /internal/status: the per-agent runtime
  // liveness the control-plane reads to render the "Connessione" badge and
  // flag "Attivo ma disconnesso". Read-only; same shared-secret gate.
  if (req.method === "GET" && url.pathname === "/internal/status") {
    if (!authorized) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const agents = opts.getAgentStatus ? opts.getAgentStatus() : [];
    // Additive `inject` block — the control-plane's
    // BridgeStatusClient reads only `agents`, so this is back-compatible.
    sendJson(res, 200, { agents, inject: injects.snapshot() });
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
  // The inject endpoint must not deliver text to an arbitrary
  // user on an arbitrary agent's channel even with the internal secret.
  // Enforce the agent's allowlist here — covering both the system-message-only
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
      // The delivery is the whole operation here — a `!ok`
      // result (channel down) must surface as a truthful 500, not a blind 202.
      const result = await opts.dispatcher.sendSystemMessage(agentId, userId, text);
      if (!result.ok) {
        logger.error({ err: result.error, agentId, userId }, "system-message-only inject delivery failed");
        sendJson(res, 500, { error: "delivery failed" });
        return;
      }
    } catch (err) {
      logger.error({ err, agentId, userId }, "system-message-only inject failed");
      sendJson(res, 500, { error: "dispatch failed" });
      return;
    }
    sendJson(res, 202, { status: "accepted" });
    return;
  }

  // Ack acceptance now, before the heads-up + model
  // turn: the caller (AcpInjector, 15s timeout, fire-and-forget) must never
  // time out on a long turn that is in fact running — that made the
  // scheduled-message dispatcher re-fire it (duplicate DMs) and the panel
  // keep the draft. The turn runs as a logged background task below; its
  // failures stay observable via logger.error + the
  // `inject` block of GET /internal/status — never a silent 202-then-nothing.
  sendJson(res, 202, { status: "accepted" });

  injects.start();
  // `runInjectTurn` never rejects by construction (it catches everything and
  // records the outcome); the trailing catch is unhandled-rejection insurance
  // so a detached-task bug can't crash the process.
  runInjectTurn(opts, injects, { agentId, userId, text, surfaceInChat, headsUp }).catch((err) => {
    logger.error({ err, agentId, userId }, "detached inject task rejected unexpectedly");
    injects.fail(agentId, userId, err);
  });
}

/**
 * The detached heads-up + model turn behind an already
 * ack'd inject. Everything is caught here: a failed heads-up stays
 * best-effort (log + continue, as before), a failed/throwing turn is logged
 * loudly and recorded on the tracker so /internal/status surfaces it.
 */
async function runInjectTurn(
  opts: InternalServerOptions,
  injects: InjectTracker,
  p: { agentId: string; userId: string; text: string; surfaceInChat: boolean; headsUp: string },
): Promise<void> {
  const { agentId, userId, text, surfaceInChat, headsUp } = p;
  try {
    if (surfaceInChat) {
      // Deterministic heads-up before the model turn (best-effort — a
      // heads-up failure must not block the actual injection). A `!ok`
      // result stays best-effort (log + continue).
      try {
        const headsUpResult = await opts.dispatcher.sendSystemMessage(agentId, userId, headsUp);
        if (!headsUpResult.ok) {
          logger.warn({ err: headsUpResult.error, agentId }, "heads-up send failed; continuing with injection");
        }
      } catch (err) {
        logger.warn({ err, agentId }, "heads-up send failed; continuing with injection");
      }
    }
    // Fail loud — a failed turn or a swallowed delivery
    // failure returns `{ ok: false }`. The HTTP ack is already gone, so the
    // truth surfaces through the log + the /internal/status inject block
    // (and the dispatcher has already sent the user-facing error copy).
    const result = await opts.dispatcher.handleMessage(agentId, userId, text);
    if (!result.ok) {
      logger.error({ err: result.error, agentId, userId }, "detached inject turn/delivery failed");
      injects.fail(agentId, userId, result.error);
      return;
    }
    injects.succeed();
  } catch (err) {
    logger.error({ err, agentId, userId }, "detached inject dispatch failed");
    injects.fail(agentId, userId, err);
  }
}

/**
 * Constant-time string compare for the shared-secret gate.
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

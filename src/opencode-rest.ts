// Thin client for opencode serve's REST API, used to recover the text the
// ACP stream dropped from a turn (see reconciler.ts).
//
// opencode serve listens on 127.0.0.1:3284 INSIDE each slot container, so it
// is reached from inside it: `docker exec <slot> curl http://127.0.0.1:3284/…`
// through the bridge's scoped docker proxy, the same road every turn already
// takes (`docker exec -i <slot> opencode acp`). The bridge shares no network
// with the slots: a network it shared with them was also the network a slot
// reached the bridge's own :7476 on, and another slot's :3284.
//
// The command resolves the password inside the slot, file first and the
// shared env second, exactly as the slot's entrypoint does when it binds the
// server, so the bridge holds no slot password at all.
//
// See OpenAPI spec at GET /doc for the full schema. Two endpoints are used
// here: `GET /session/{sessionID}/message/{messageID}` →
// `{ info: AssistantMessage, parts: Part[] }` for the reconciliation, and
// `GET /session/{sessionID}/message?limit=1` → the newest message alone, to
// learn whether the session is writing its summary (see CompactionProbe).

import { execFile } from "node:child_process";
import { makeLogger } from "./logger.js";
import type { CanonicalMessage, CanonicalPart } from "./reconciler.js";

const logger = makeLogger("cerase-acp.opencode-rest");

/** The slot whose REST surface a fetch reads, resolved per agent. */
export interface RestEndpoint {
  containerName: string;
}

/**
 * Injectable so tests can substitute a canned implementation. Real
 * production code uses `defaultFetcher`. Returns `null` when the
 * server has no record of the message (404) — the reconciler can
 * treat that as "nothing to reconcile" rather than throwing.
 */
export type CanonicalFetcher = (
  endpoint: RestEndpoint,
  sessionId: string,
  messageId: string,
) => Promise<CanonicalMessage | null>;

/** Runs `docker <args>`; `ok` is false on a non-zero exit or a timeout. */
export type SlotExec = (args: string[], timeoutMs: number) => Promise<{ stdout: string; ok: boolean }>;

/**
 * What runs inside the slot. The path is `$1`, an argument and never part of
 * the script, so nothing a session id carries can become shell. The status code
 * is appended on its own last line.
 */
export const SLOT_REST_SCRIPT =
  'PW=$(cat /etc/opencode/server-password 2>/dev/null); [ -n "$PW" ] || PW="$OPENCODE_SERVER_PASSWORD"; ' +
  'exec curl -sS --max-time 3 -u "opencode:$PW" -H "Accept: application/json" -w "\\n%{http_code}" "http://127.0.0.1:3284$1"';

/**
 * Build an endpoint for a known agent container name. Returns `null` for a
 * name docker could not have given a container, in which case the
 * reconciliation is skipped quietly.
 *
 * Caller passes the container name directly (e.g. `cerase-agent-1`), which
 * the session manager takes from `spawn.args[2]` of agents.yaml.
 */
export function defaultEndpointForAgent(containerName: string): RestEndpoint | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(containerName)) return null;
  return { containerName };
}

/** Runs the `docker` CLI through the bridge's docker proxy, as every turn does. */
export const dockerExec: SlotExec = (args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      "docker",
      args,
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err: Error | null, stdout: string) => {
        resolve({ stdout: stdout ?? "", ok: err === null });
      },
    );
  });

/**
 * GET `path` from the opencode server inside `container`, and the JSON it
 * answered. `null` on a 404, and on anything that is not a 2xx carrying JSON,
 * which is logged: every reader of this surface degrades to "nothing known"
 * rather than failing the turn it serves.
 */
async function readSlot(exec: SlotExec, container: string, path: string): Promise<unknown> {
  const { stdout, ok } = await exec(["exec", container, "sh", "-c", SLOT_REST_SCRIPT, "sh", path], 5000);
  if (!ok) {
    logger.warn({ container, path }, "opencode REST read from inside the slot failed");
    return null;
  }
  const cut = stdout.lastIndexOf("\n");
  const status = Number(stdout.slice(cut + 1).trim());
  if (status === 404) return null;
  if (!(status >= 200 && status < 300)) {
    logger.warn({ container, path, status }, "opencode REST returned non-2xx");
    return null;
  }
  try {
    return JSON.parse(cut >= 0 ? stdout.slice(0, cut) : "");
  } catch (err) {
    logger.warn({ container, path, err: (err as Error).message }, "opencode REST answered something that is not JSON");
    return null;
  }
}

/**
 * A fetcher that reads the message from inside the slot. 5s end to end: the
 * reconciliation is a "best effort" after-the-fact recovery, and a slot that
 * does not answer promptly degrades to "nothing reconciled" rather than
 * blocking the turn.
 */
export function execFetcher(exec: SlotExec = dockerExec): CanonicalFetcher {
  return async (endpoint, sessionId, messageId) => {
    const path = `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`;
    const body = (await readSlot(exec, endpoint.containerName, path)) as {
      info?: { id?: string };
      parts?: Array<{ id: string; type: string; text?: string; ignored?: boolean }>;
    } | null;
    if (!body?.info?.id || !Array.isArray(body.parts)) return null;
    const parts: CanonicalPart[] = body.parts.map((p) => ({
      id: p.id,
      type: p.type,
      text: p.text ?? "",
      ignored: p.ignored ?? false,
    }));
    return { id: body.info.id, parts };
  };
}

/**
 * Which summary of its history a session is writing right now: the id of that
 * message, or `null` when it is writing none or the slot could not say.
 *
 * opencode 1.18.18 summarises a session in an assistant message of its own,
 * flagged `summary: true` (mode and agent `compaction`), and stamps
 * `time.completed` on it when the summary call ends. Its ACP layer sends no
 * update for that message until the summary's text streams, and the model
 * reads the whole conversation before it writes a word of it. So until then
 * the only place that says a summary is under way is the session's newest
 * message, which `GET /session/{id}/message?limit=1` returns.
 */
export type CompactionProbe = (container: string, sessionId: string) => Promise<string | null>;

/** The probe that asks the slot's opencode server: see CompactionProbe. */
export function execCompactionProbe(exec: SlotExec = dockerExec): CompactionProbe {
  return async (container, sessionId) => {
    const body = await readSlot(exec, container, `/session/${encodeURIComponent(sessionId)}/message?limit=1`);
    if (!Array.isArray(body)) return null;
    const info = (body.at(-1) as { info?: unknown } | undefined)?.info as
      | { id?: unknown; role?: unknown; summary?: unknown; time?: { completed?: unknown } }
      | undefined;
    if (info?.role !== "assistant" || info.summary !== true) return null;
    if (typeof info.time?.completed === "number") return null;
    return typeof info.id === "string" && info.id.length > 0 ? info.id : null;
  };
}

/** Production fetcher: `docker exec` through the bridge's docker proxy. */
export const defaultFetcher: CanonicalFetcher = execFetcher();

/**
 * Where a session stands with the summaries of its history, read before a
 * person's message is sent to it.
 *
 * opencode 1.18.18 starts a summary by writing a user message holding a
 * `compaction` part, the marker, and treats every marker newer than the
 * session's last finished assistant message as work still to do. The next
 * prompt runs that work first, and runs it under the newest user message, which
 * is then the person's: the summary is parented on a message that holds no
 * marker, so it cuts nothing, and the person's message gets no answer of its
 * own. A summary stopped halfway (a slot restart, a provider error) leaves its
 * marker in exactly that state.
 *
 * - `settled`: no marker waits; the message can be sent.
 * - `writing`: a marker waits and the slot's server is working on the session,
 *   so its summary is being written; `messageId` is that summary, or null when
 *   it has not been created yet.
 * - `stranded`: a marker waits and nothing is writing its summary.
 */
export type SummaryState =
  | { kind: "settled" }
  | { kind: "writing"; messageId: string | null }
  | { kind: "stranded"; markerId: string };

interface RestMessage {
  info?: {
    id?: unknown;
    role?: unknown;
    summary?: unknown;
    finish?: unknown;
    error?: unknown;
    parentID?: unknown;
    time?: { completed?: unknown };
  };
  parts?: Array<{ type?: unknown }>;
}

/**
 * The state of the newest messages of a session, oldest first as the server
 * serves them, and whether the slot's server reports the session busy.
 *
 * Read the way the runtime reads it: walking back from the newest message, an
 * assistant message carrying a `finish` ends the search, because no marker
 * before it is still work; the first marker met before one is.
 */
export function summaryStateOf(messages: unknown, busy: boolean): SummaryState {
  if (!Array.isArray(messages)) return { kind: "settled" };
  const list = messages.filter((m): m is RestMessage => typeof m === "object" && m !== null);
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i] as RestMessage;
    const info = message.info ?? {};
    if (info.role === "assistant" && typeof info.finish === "string" && info.finish !== "") {
      return { kind: "settled" };
    }
    const marker =
      info.role === "user" &&
      typeof info.id === "string" &&
      (message.parts ?? []).some((part) => part?.type === "compaction");
    if (!marker) continue;
    const markerId = info.id as string;
    const summary = list
      .slice(i + 1)
      .find((m) => m.info?.role === "assistant" && m.info.summary === true && m.info.parentID === markerId);
    const unfinished =
      summary === undefined || (!summary.info?.error && typeof summary.info?.time?.completed !== "number");
    if (busy && unfinished) {
      const id = summary?.info?.id;
      return { kind: "writing", messageId: typeof id === "string" ? id : null };
    }
    return { kind: "stranded", markerId };
  }
  return { kind: "settled" };
}

/**
 * Reads a session's SummaryState from its slot: `null` when the slot could not
 * be read, which the caller takes as nothing known.
 */
export type SummaryStateProbe = (container: string, sessionId: string) => Promise<SummaryState | null>;

/** How many of the newest messages are read: a marker waits behind at most a few. */
const SUMMARY_STATE_WINDOW = 20;

/** The probe that asks the slot's opencode server: see SummaryStateProbe. */
export function execSummaryStateProbe(exec: SlotExec = dockerExec): SummaryStateProbe {
  return async (container, sessionId) => {
    const messages = await readSlot(
      exec,
      container,
      `/session/${encodeURIComponent(sessionId)}/message?limit=${SUMMARY_STATE_WINDOW}`,
    );
    if (!Array.isArray(messages)) return null;
    const status = await readSlot(exec, container, "/session/status");
    const entry =
      typeof status === "object" && status !== null ? (status as Record<string, unknown>)[sessionId] : undefined;
    const type = typeof entry === "object" && entry !== null ? (entry as { type?: unknown }).type : undefined;
    return summaryStateOf(messages, type === "busy" || type === "retry");
  };
}

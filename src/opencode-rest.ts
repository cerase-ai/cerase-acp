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

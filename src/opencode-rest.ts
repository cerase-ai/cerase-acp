// Thin client for opencode serve's REST API. Currently used by M16
// shadow-channel reconciliation; expand if other audit-channel features
// land (M9 message export, session inspection, etc.).
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
// See OpenAPI spec at GET /doc for the full schema. The single endpoint
// we use here is `GET /session/{sessionID}/message/{messageID}` →
// `{ info: AssistantMessage, parts: Part[] }`.

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
 * name docker could not have given a container, in which case M16
 * reconciliation is skipped quietly.
 *
 * Caller passes the container name directly (e.g. `cerase-agent-1`).
 * Older versions of this function accepted an `agentId` string and
 * prefixed it with `cerase-agent-`, which produced a double-prefix
 * (`cerase-agent-agent-1`) once the slot-pool naming landed in
 * cerase-core (Agent ids became `agent-N`). Session-manager now
 * derives the container name from `spawn.args[2]` of agents.yaml.
 */
export function defaultEndpointForAgent(containerName: string): RestEndpoint | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(containerName)) return null;
  return { containerName };
}

const dockerExec: SlotExec = (args, timeoutMs) =>
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
 * A fetcher that reads the message from inside the slot. 5s end to end: the
 * reconciliation is a "best effort" after-the-fact recovery, and a slot that
 * does not answer promptly degrades to "nothing reconciled" rather than
 * blocking the turn.
 */
export function execFetcher(exec: SlotExec = dockerExec): CanonicalFetcher {
  return async (endpoint, sessionId, messageId) => {
    const path = `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`;
    const container = endpoint.containerName;
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
    let body: {
      info?: { id?: string };
      parts?: Array<{ id: string; type: string; text?: string; ignored?: boolean }>;
    };
    try {
      body = JSON.parse(cut >= 0 ? stdout.slice(0, cut) : "");
    } catch (err) {
      logger.warn(
        { container, path, err: (err as Error).message },
        "opencode REST answered something that is not JSON",
      );
      return null;
    }
    if (!body.info?.id || !Array.isArray(body.parts)) return null;
    const parts: CanonicalPart[] = body.parts.map((p) => ({
      id: p.id,
      type: p.type,
      text: p.text ?? "",
      ignored: p.ignored ?? false,
    }));
    return { id: body.info.id, parts };
  };
}

/** Production fetcher: `docker exec` through the bridge's docker proxy. */
export const defaultFetcher: CanonicalFetcher = execFetcher();

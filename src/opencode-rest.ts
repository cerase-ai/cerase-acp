// Thin client for opencode serve's REST API. Currently used by M16
// shadow-channel reconciliation; expand if other audit-channel features
// land (M9 message export, session inspection, etc.).
//
// opencode serve listens on :3284 inside each cerase-agent-{template}
// container with HTTP basic auth (username hardcoded to "opencode",
// password is `OPENCODE_SERVER_PASSWORD` shared between agent and
// bridge containers via docker-compose env). Within the bridge
// container the agent is reachable by its compose service name —
// for template id `doc-qa` the host is `cerase-agent-doc-qa`.
//
// See OpenAPI spec at GET /doc for the full schema. The single endpoint
// we use here is `GET /session/{sessionID}/message/{messageID}` →
// `{ info: AssistantMessage, parts: Part[] }`.

import { makeLogger } from "./logger.js";
import type { CanonicalMessage, CanonicalPart } from "./reconciler.js";

const logger = makeLogger("cerase-acp.opencode-rest");

/** Endpoint coordinates resolved per-agent at startup. */
export interface RestEndpoint {
  baseURL: string;
  username: string;
  password: string;
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

/**
 * Derive an endpoint for the standard cerase-agent-{id} container
 * naming convention. Bridge and agent containers live on the same
 * docker network so the service name resolves; password comes from
 * the env var shared via docker-compose. Returns `null` when the
 * password isn't configured (test environments, host shell), in
 * which case M16 reconciliation is skipped quietly.
 */
export function defaultEndpointForAgent(agentId: string): RestEndpoint | null {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return null;
  return {
    baseURL: `http://cerase-agent-${agentId}:3284`,
    username: "opencode",
    password,
  };
}

/**
 * Production fetcher. Uses Node's built-in `fetch` (Node ≥18). 2s
 * client-side timeout — the reconciliation is a "best effort"
 * after-the-fact recovery; if the REST endpoint isn't responding
 * promptly we degrade gracefully rather than blocking the turn.
 */
export const defaultFetcher: CanonicalFetcher = async (
  endpoint,
  sessionId,
  messageId,
) => {
  const url = `${endpoint.baseURL}/session/${sessionId}/message/${messageId}`;
  const authz = "Basic " + Buffer.from(`${endpoint.username}:${endpoint.password}`).toString("base64");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { authorization: authz, accept: "application/json" },
      signal: ctrl.signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      logger.warn({ url, status: res.status }, "opencode REST returned non-2xx");
      return null;
    }
    const body = (await res.json()) as {
      info?: { id?: string };
      parts?: Array<{ id: string; type: string; text?: string; ignored?: boolean }>;
    };
    if (!body.info?.id || !Array.isArray(body.parts)) return null;
    const parts: CanonicalPart[] = body.parts.map((p) => ({
      id: p.id,
      type: p.type,
      text: p.text ?? "",
      ignored: p.ignored ?? false,
    }));
    return { id: body.info.id, parts };
  } catch (err) {
    logger.warn({ url, err: (err as Error).message }, "opencode REST fetch failed");
    return null;
  } finally {
    clearTimeout(timer);
  }
};

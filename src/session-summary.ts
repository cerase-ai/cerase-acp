// M-SESSION-CONTEXT-HYGIENE-1 — capture the engine's compaction summary.
//
// When OpenCode auto-compacts a chat-only session it emits an "Anchored Summary"
// block. The bridge already DETECTS + withholds it from chat (egress-redaction).
// Instead of discarding it, we POST it to the control-plane over the internal
// channel so it is persisted as the assistant's canonical rolling summary — the
// warm-resume + measurement substrate of the context-hygiene design.
//
// Best-effort + fire-and-forget: a capture failure must NEVER affect the user's
// turn, so this resolves to a boolean and never throws.

export interface SessionSummaryOptions {
  controlPlaneUrl: string;
  internalSecret: string;
  fetchImpl?: typeof fetch;
}

/**
 * POST the captured compaction summary to the control-plane.
 * Resolves true on a 2xx, false on empty input / non-ok / network error.
 */
export async function postSessionSummary(
  agentId: string,
  summary: string,
  opts: SessionSummaryOptions,
): Promise<boolean> {
  const trimmed = summary.trim();
  if (!agentId || !trimmed) return false;

  const f = opts.fetchImpl ?? fetch;
  const url = `${opts.controlPlaneUrl.replace(/\/$/, "")}/api/internal/session-summary`;

  try {
    const resp = await f(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.internalSecret}`,
      },
      body: JSON.stringify({ agent_id: agentId, summary: trimmed }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

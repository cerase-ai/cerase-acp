// Shadow-channel reconciliation against opencode serve's REST snapshot.
//
// Background — M16 of cerase-acp. The ACP stdio child (`opencode acp`)
// has a documented race where session/update notifications can land
// AFTER the session/prompt RPC reply with stopReason: end_turn (upstream
// anomalyco/opencode#17505, PR #21316 was auto-closed by the
// compliance bot before review). Our M15 drain bumps the safety
// ceiling to 8s; M16 closes the structural gap: after the drain, we
// fetch the canonical assistant message from `opencode serve`'s REST
// API (`GET /session/{sid}/message/{mid}`) and emit synthetic chunks
// for whatever the delta stream missed.
//
// This module is pure: it doesn't fetch anything. The fetching belongs
// to the session manager; this just diffs `seen` against `canonical`
// and returns the deltas to replay.

/**
 * One `parts[]` entry from the REST snapshot. We model only the
 * fields M16 cares about — text content, kind, and the `ignored`
 * marker that opencode's own delta path uses to skip parts (see
 * agent.ts:466 — `part.ignored !== true`). Tool / step / file /
 * patch parts have non-streaming kinds; we leave their typing
 * loose since we only differentiate "text" / "reasoning" from
 * everything else.
 */
export interface CanonicalPart {
  id: string;
  type: "text" | "reasoning" | string;
  text: string;
  ignored?: boolean;
}

export interface CanonicalMessage {
  id: string;
  parts: CanonicalPart[];
}

/**
 * Aggregated state the SessionManager accumulates while observing
 * ACP session/update notifications during a turn. The reconciler
 * compares these strings (concatenation of all chunks received,
 * preserving order) against the canonical text/reasoning content
 * from the REST snapshot. Order is implicit: opencode-acp emits
 * deltas in part-order, so concatenated chunks reproduce the
 * concatenated part text.
 */
export interface SeenState {
  textSeen: string;
  reasoningSeen: string;
}

export interface ReconciledDelta {
  kind: "text" | "reasoning";
  text: string;
}

const collect = (
  message: CanonicalMessage,
  kind: "text" | "reasoning",
): string => {
  let acc = "";
  for (const part of message.parts) {
    if (part.type !== kind) continue;
    // opencode's own delta emitter skips `ignored: true` text parts
    // (agent.ts:466 — `part.ignored !== true`). Reasoning parts have
    // no `ignored` field in the opencode schema; we permit it
    // defensively but it should never be set.
    if (part.ignored) continue;
    acc += part.text;
  }
  return acc;
};

/**
 * Diff what we received via the ACP delta stream against the canonical
 * message snapshot fetched from REST. Returns the synthetic deltas the
 * caller should replay to bring the client up to par.
 *
 * Order: text delta first, reasoning delta second. Callers preserving
 * the conventional thought-before-text ordering may swap them before
 * forwarding; downstream consumers (CLI streaming helper, Discord
 * send-queue) treat each chunk independently anyway.
 *
 * Safety: if `seen` is LONGER than `canonical` (impossible-in-theory
 * but we've been bitten by impossible-in-theory races before), we
 * return an empty delta to avoid duplicating visible text — better to
 * under-report.
 */
export function reconcile(
  seen: SeenState,
  canonical: CanonicalMessage,
): ReconciledDelta[] {
  const out: ReconciledDelta[] = [];
  const canonicalText = collect(canonical, "text");
  const canonicalReasoning = collect(canonical, "reasoning");

  if (canonicalText.startsWith(seen.textSeen) && canonicalText.length > seen.textSeen.length) {
    out.push({ kind: "text", text: canonicalText.slice(seen.textSeen.length) });
  }
  if (
    canonicalReasoning.startsWith(seen.reasoningSeen) &&
    canonicalReasoning.length > seen.reasoningSeen.length
  ) {
    out.push({
      kind: "reasoning",
      text: canonicalReasoning.slice(seen.reasoningSeen.length),
    });
  }
  return out;
}

// Capture the engine's compaction summary.
//
// When OpenCode auto-compacts a chat-only session it emits an "Anchored Summary"
// block. The bridge already DETECTS + withholds it from chat (egress-redaction).
// Instead of discarding it, we POST it to the control-plane over the internal
// channel so it is persisted as the assistant's canonical rolling summary — the
// warm-resume + measurement substrate of the context-hygiene design.
//
// Best-effort + fire-and-forget: a capture failure must NEVER affect the user's
// turn, so this resolves to a boolean and never throws.
//
// The same route also serves the stored summary back, for the one moment the
// bridge needs it: a session that grew past what the runtime can summarise is
// replaced by a new one, and the new one starts from this summary.

import { bridgePromptLine } from "./bridge-prompt.js";

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

/** The assistant's last rolling summary, as the control-plane stores it. */
export interface LastSummary {
  text: string;
  /** When it was written, ISO 8601 with the organisation's offset. */
  at?: string;
}

/**
 * Read the assistant's last rolling summary from the control-plane.
 *
 * Resolves undefined when the assistant has none. THROWS on anything that is
 * not a 2xx, so a caller can log that the summary could not be read rather
 * than report that there was none: a control-plane without this route answers
 * 404, and the conversation then starts over without it.
 */
export async function fetchSessionSummary(
  agentId: string,
  opts: SessionSummaryOptions,
): Promise<LastSummary | undefined> {
  const f = opts.fetchImpl ?? fetch;
  const url = `${opts.controlPlaneUrl.replace(/\/$/, "")}/api/internal/session-summary/${encodeURIComponent(agentId)}`;
  const resp = await f(url, { headers: { Authorization: `Bearer ${opts.internalSecret}` } });
  if (!resp.ok) throw new Error(`session-summary: HTTP ${resp.status}`);
  const body = (await resp.json()) as { summary?: unknown; summarised_at?: unknown };
  const text = typeof body.summary === "string" ? body.summary.trim() : "";
  if (text === "") return undefined;
  return typeof body.summarised_at === "string" && body.summarised_at !== ""
    ? { text, at: body.summarised_at }
    : { text };
}

/**
 * What the assistant is told at the start of the session that replaces one
 * which outgrew its summary, ahead of the person's message and for it alone.
 *
 * It opens with the bridge's own line, so a console that reads the stored
 * message back whole hides it rather than showing it as the person's.
 */
export function startedOverNote(summary: LastSummary | undefined): string {
  const opening = [
    bridgePromptLine("session", "started over"),
    "This is a new session. The previous conversation with this person grew too long to be summarised and could not go on, so it was started over, and the person has been told so in their language.",
  ];
  if (!summary) {
    return [
      ...opening,
      "No summary of the previous conversation exists. Answer the message below with what you know, and ask the person for any detail from before that you need.",
    ].join("\n\n");
  }
  const when = summary.at ? `, written ${summary.at}` : "";
  return [
    ...opening,
    `Below is the last summary of the previous conversation${when}. Take it as what you remember of that conversation, then answer the message below, and ask the person for any detail it does not hold.`,
    summary.text,
  ].join("\n\n");
}

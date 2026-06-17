/**
 * M-AGENT-VOICE-1 (A) — deterministic egress redaction of the underlying
 * engine's identity from user-facing replies.
 *
 * Cerase runs on OpenCode, but the user must never see that — even if the
 * model degrades and ignores the prompt-level rule ("se degrada ci casca").
 * This is the safety net at the OUTPUT boundary: it runs on every reply,
 * regardless of what the model produced.
 *
 * We do NOT fork OpenCode — we redact at the boundary, so upstream updates
 * flow in normally. The trade-off: this identifier list must be REVIEWED on
 * every OpenCode version bump (a new upstream tool name / path could leak
 * until it's added here). That review note also lives in the deploy doc.
 *
 * Kept intentionally small + deterministic. It does NOT try to be a
 * general-purpose scrubber — it targets the known engine identifiers.
 */

/**
 * Case-insensitive engine identifiers to scrub. Each entry maps a regex to
 * its replacement. Order matters: the more specific patterns run first so a
 * broad "opencode" → "Cerase" pass doesn't mangle them into odd fragments.
 */
const ENGINE_REDACTIONS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // Env var + version identifiers.
  { pattern: /\bOPENCODE_VERSION\b/gi, replacement: "CERASE_VERSION" },
  // The upstream built-in skill that reconfigures the engine (also disabled
  // at the slot level via opencode.json permission.skill deny — this is the
  // belt-and-suspenders for any leak in error text).
  { pattern: /\bcustomize-opencode\b/gi, replacement: "le impostazioni dell'assistente" },
  // `.opencode/...` config/skill paths that surface in upstream error text.
  { pattern: /\.opencode\b/gi, replacement: ".cerase" },
  // Bare engine name, last (catches OpenCode / opencode / OPENCODE). The
  // capitalised form keeps a natural-looking "Cerase".
  { pattern: /\bopen[\s-]?code\b/gi, replacement: "Cerase" },
];

/**
 * Strip/replace known OpenCode engine identifiers from a user-facing reply.
 * Pure + idempotent. Empty/whitespace input is returned unchanged.
 */
export function redactEngineIdentifiers(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { pattern, replacement } of ENGINE_REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * M-CONNECTOR-CONNECT-AFFORDANCE-1 Stage 4 — strip a tool call the model spelled
 * out as TEXT (a "DSML" artifact) before it reaches the chat.
 *
 * When the model is given a poor affordance it sometimes emits the structured
 * tool-call syntax as plain text instead of an actual tool call — e.g.
 * `<｜｜DSML｜｜tool_calls> <｜｜DSML｜｜invoke …> …` (the markers use the fullwidth
 * vertical bar U+FF5C). That is internal scaffolding, never an answer, and once
 * leaked verbatim into a user's chat. This is the egress safety net (the real
 * fix is the affordance — see [[feedback_never_blame_the_model]] — but the
 * boundary must never pass raw tool-call syntax to a user).
 *
 * Deterministic + tolerant of drift: it targets any angle-bracket marker that
 * contains "DSML". Pure + idempotent; if a reply is ONLY such a block the result
 * is empty and the bridge withholds it.
 */
export function stripToolCallArtifacts(text: string): string {
  if (!text) return text;
  let out = text;
  // 1) whole balanced `…tool_calls` blocks (the spelled-out tool call).
  out = out.replace(
    /<[^>]*?DSML[^>]*?tool_calls[^>]*?>[\s\S]*?<\/[^>]*?DSML[^>]*?tool_calls[^>]*?>/gi,
    "",
  );
  // 2) an unbalanced / truncated opening block → strip to the end.
  out = out.replace(/<[^>]*?DSML[^>]*?tool_calls[^>]*?>[\s\S]*$/gi, "");
  // 3) any remaining stray DSML tags (invoke / parameter, balanced or not).
  out = out.replace(/<\/?[^>]*?DSML[^>]*?>/gi, "");
  // tidy the blank lines the removal may leave behind.
  out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

/**
 * M-AGENT-SUMMARY-LEAK-1 — the engine's internal context-compaction summary.
 *
 * During mid-session compaction OpenCode produces a structured session-state
 * block (Anchored Summary / Constraints & Preferences / Active Tools & State /
 * Next Actions / Technical Notes / Workspace Paths & Files). It is an INTERNAL
 * artefact, not an answer — yet it once surfaced as an assistant reply, leaking
 * a masked PII token (`<nome …>`), workspace file paths, and tool state to the
 * user. The fix is to recognise such a block at the egress boundary and
 * withhold it entirely (a reply that IS the session summary is never
 * user-facing — see the sibling call in bridge.ts).
 *
 * Detection is deliberately tolerant of FORMAT DRIFT — the section names can
 * change on an OpenCode bump, so we don't anchor on one exact string. REVIEW
 * this marker set on every OpenCode version bump (same review note as the
 * engine-identifier list; it also lives in the deploy doc).
 */
const SUMMARY_SECTION_MARKERS: ReadonlyArray<RegExp> = [
  /\banchored\s+summary\b/i,
  /\bconstraints?\s*&\s*preferences\b/i,
  /\bactive\s+tools?\s*&\s*state\b/i,
  /\bnext\s+actions\b/i,
  /\btechnical\s+notes\b/i,
  /\bworkspace\s+paths?\s*(?:&|and)?\s*files\b/i,
];
// "Anchored Summary" is the block's title — on its own a strong signal.
const STRONG_SUMMARY_MARKER = /\banchored\s+summary\b/i;
// Below this many corroborating section headers we don't treat prose as a summary.
const SUMMARY_HEADER_THRESHOLD = 3;

/**
 * Whether `text` is (or contains) the engine's internal compaction/session
 * summary block. True ⇒ the bridge withholds the whole reply. Pure; empty
 * input is not a summary.
 */
export function isInternalSummaryBlock(text: string): boolean {
  if (!text || !text.trim()) return false;
  if (STRONG_SUMMARY_MARKER.test(text)) return true;
  let hits = 0;
  for (const re of SUMMARY_SECTION_MARKERS) {
    if (re.test(text)) hits += 1;
  }
  return hits >= SUMMARY_HEADER_THRESHOLD;
}

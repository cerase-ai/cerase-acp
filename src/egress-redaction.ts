/**
 * Deterministic egress redaction of the underlying
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
 * Model/provider brand names + internal artifacts the model
 * sometimes leaks despite the prompt-level hygiene rule (SpendLogs: "Claude",
 * `.mcp.json`, backticked recipe names).
 *
 * The bare brand names (Claude, GPT, OpenAI, …) are HIGH false-positive — a
 * person named Claude, a user asking about OpenAI — so they are redacted ONLY in
 * a self-identification CONTEXT ("sono X" / "giro su X" / "I'm X" / "run on X"),
 * never bare. Pure-infra strings with no legitimate user-facing meaning
 * (`LiteLLM`, `.mcp.json`, a backticked internal recipe id) are redacted outright.
 * REVIEW this set on every OpenCode/model-roster bump (same note as above).
 */
const PROVIDER_BRANDS = "Claude|ChatGPT|GPT(?:[\\s-]?\\d[\\w.]*)?|OpenAI|Anthropic|DeepSeek|Gemini|Llama|Mistral";

/**
 * File extensions a delivered document can carry.
 *
 * Used as a NEGATIVE condition: a backticked `word-word.suffix` is a recipe
 * reference unless its suffix is one of these, in which case it is a filename
 * the assistant is naming to the person it is talking to.
 *
 * A closed set is exactly what makes this the right side to enumerate. Recipe
 * method names are open-ended (`search`, `list_records`, whatever a connector
 * adds next week); the extensions a document arrives with are not, and a new
 * one is a deliberate act with an obvious place to record it.
 */
const FILE_EXTENSIONS = [
  // documents
  "pdf",
  "docx",
  "doc",
  "odt",
  "rtf",
  "txt",
  "md",
  "markdown",
  // spreadsheets and data
  "xlsx",
  "xls",
  "ods",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "xml",
  // presentations
  "pptx",
  "ppt",
  "odp",
  "key",
  // images and media
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "heic",
  "mp3",
  "mp4",
  "wav",
  "mov",
  // archives
  "zip",
  "tar",
  "gz",
  "tgz",
  "7z",
  // web
  "html",
  "htm",
  "css",
].join("|");

const IDENTITY_AND_ARTIFACT_REDACTIONS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // Self-identification, Italian: "sono Claude" / "sei GPT-4".
  { pattern: new RegExp(`\\b(sono|sei)\\s+(?:${PROVIDER_BRANDS})\\b`, "gi"), replacement: "$1 un assistente Cerase" },
  // Self-identification, English: "I'm Claude" / "I am GPT".
  { pattern: new RegExp(`\\b(I['’]?m|I am)\\s+(?:${PROVIDER_BRANDS})\\b`, "gi"), replacement: "$1 a Cerase assistant" },
  // "giro su X" / "basato su X" / "modello X" (X also covers the LiteLLM proxy).
  {
    pattern: new RegExp(
      `\\b(giro su|girando su|basato su|alimentato da|costruito su|costruito con|sviluppato da|creato da|il modello|modello)\\s+(?:${PROVIDER_BRANDS}|LiteLLM)\\b`,
      "gi",
    ),
    replacement: "$1 Cerase",
  },
  // English equivalents: "run on X" / "powered by X" / "the model X".
  {
    pattern: new RegExp(
      `\\b(run on|running on|powered by|built on|based on|developed by|made by|the model|model)\\s+(?:${PROVIDER_BRANDS}|LiteLLM)\\b`,
      "gi",
    ),
    replacement: "$1 Cerase",
  },
  // Bare internal-infra strings (no legitimate user-facing meaning).
  { pattern: /\bLiteLLM\b/gi, replacement: "Cerase" },
  { pattern: /\.mcp\.json\b/gi, replacement: "la configurazione" },
  // Backticked internal recipe identifiers, e.g. `cerase-search.search`,
  // `airtable-power.list_records`.
  //
  // The comment that stood here said the hyphen in the namespace kept this off
  // "a plain filename like `report.md`". That holds only for filenames WITHOUT
  // a hyphen, and the shipped skills mandate hyphenated ones by name --
  // `report-q3.docx`, `q3-results-presentation.pdf`, `presentation-brief.md`,
  // `pending-skill-<slug>.md` among them. So a user who asked for a
  // presentation was told, verbatim, "Ecco uno strumento".
  //
  // The real difference is the SUFFIX, not the hyphen: a recipe reference ends
  // in a method name, a filename ends in a file extension. Extensions are a
  // closed set and method names are not, so the exclusion is written on the
  // closed one.
  {
    // The alternation is GROUPED inside the lookahead, and the group is what
    // ties the extension to the closing backtick. Written `(?!pdf|docx|md`)`
    // the backtick binds to the last branch only, so the earlier branches
    // match a bare PREFIX: the exclusion then fires on any suffix beginning
    // with an extension, and `cerase-search.mdlist` -- a real recipe -- would
    // reach the user unredacted.
    pattern: new RegExp("`[a-z0-9]+(?:[-_][a-z0-9]+)+\\.(?:(?!(?:" + FILE_EXTENSIONS + ")`)[a-z0-9_])+`", "gi"),
    replacement: "uno strumento",
  },
];

/**
 * When the opt-in parallel-work behaviour is on, the assistant fans
 * independent sub-tasks out to the engine's built-in `task` /
 * subagent primitive. It must narrate that like a colleague ("intanto porto
 * avanti X e Y") and NEVER expose the internal nouns. The SlotWriter voice rule
 * keeps the common path clean; this is the deterministic backstop for a degraded
 * turn that leaks the scaffolding word.
 *
 * HIGH-PRECISION on `task`: the bare word is a legitimate user-facing noun — a
 * board work-item ("ho creato il task", "le tue task") — so it is NEVER scrubbed
 * bare (that would mangle the cerase-tasks board language). Only the unambiguous
 * ENGINE-primitive surface is scrubbed:
 *   - `subagent` / `sub-agent` (no legitimate user-facing meaning at all);
 *   - the paired `task tool` / `task subagent` phrase;
 *   - a backticked `task(...)` invocation spelled out as text.
 * Each collapses to the colleague phrase "lavoro in parallelo", which reads in
 * place of the noun ("avvio un subagent" → "avvio un lavoro in parallelo").
 * REVIEW this set on every OpenCode bump (same note as the engine list above).
 */
const MULTITASK_REDACTIONS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // The engine primitive named explicitly ("task tool" / "task subagent"). Run
  // BEFORE the bare-subagent pass so "task subagent" collapses as one unit.
  { pattern: /\btask[\s-]?(?:tool|subagents?|sub-agents?)\b/gi, replacement: "lavoro in parallelo" },
  // A backticked `task(...)` call spelled out as text — internal call syntax.
  { pattern: /`task\([^`]*\)`/gi, replacement: "lavoro in parallelo" },
  // Bare engine "subagent(s)" — internal jargon, never user-facing.
  { pattern: /\bsub[\s-]?agents?\b/gi, replacement: "lavoro in parallelo" },
];

/**
 * Strip/replace known OpenCode engine identifiers + leaked provider names /
 * internal artifacts from a user-facing reply. Pure + idempotent. Empty input
 * is returned unchanged.
 */
export function redactEngineIdentifiers(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { pattern, replacement } of ENGINE_REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  for (const { pattern, replacement } of IDENTITY_AND_ARTIFACT_REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  for (const { pattern, replacement } of MULTITASK_REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Strip a tool call the model spelled out as TEXT (a "DSML" artifact) before
 * it reaches the chat.
 *
 * When the model is given a poor affordance it sometimes emits the structured
 * tool-call syntax as plain text instead of an actual tool call — e.g.
 * `<｜｜DSML｜｜tool_calls> <｜｜DSML｜｜invoke …> …` (the markers use the fullwidth
 * vertical bar U+FF5C). That is internal scaffolding, never an answer, and once
 * leaked verbatim into a user's chat. This is the egress safety net (the real
 * fix is the affordance the model was given, never the model itself — but the
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
  out = out.replace(/<[^>]*?DSML[^>]*?tool_calls[^>]*?>[\s\S]*?<\/[^>]*?DSML[^>]*?tool_calls[^>]*?>/gi, "");
  // 2) an unbalanced / truncated opening block → strip to the end.
  out = out.replace(/<[^>]*?DSML[^>]*?tool_calls[^>]*?>[\s\S]*$/gi, "");
  // 3) any remaining stray DSML tags (invoke / parameter, balanced or not).
  out = out.replace(/<\/?[^>]*?DSML[^>]*?>/gi, "");
  // tidy the blank lines the removal may leave behind.
  out = out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out;
}

/**
 * The engine's internal context-compaction summary.
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
  // The engine's own names.
  /\banchored\s+summary\b/i,
  /\bconstraints?\s*&\s*preferences\b/i,
  /\bactive\s+tools?\s*&\s*state\b/i,
  /\bnext\s+actions\b/i,
  /\btechnical\s+notes\b/i,
  /\bworkspace\s+paths?\s*(?:&|and)?\s*files\b/i,
  // OURS. The appliance replaces the engine's section list with its own in
  // SlotWriter::compactionPrompt(), and this set was left on the engine's —
  // so the one shape the product actually asks the model to produce was the
  // one shape the detector could not see. An assistant answered a request to
  // join a meeting with its whole working-memory block, in a customer's chat.
  //
  // The note above says to review these on an OpenCode bump. The drift came
  // from our side instead: the prompt naming the sections is in cerase-core
  // and this list is here, with nothing holding them equal.
  /^\s*#{1,4}\s*objective\s*$/im,
  /^\s*#{1,4}\s*important\s+details\s*$/im,
  /^\s*#{1,4}\s*work\s+state\s*$/im,
  /^\s*#{1,4}\s*next\s+move\s*$/im,
  /^\s*#{1,4}\s*relevant\s+files\s*$/im,
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
  if (!text?.trim()) return false;
  if (STRONG_SUMMARY_MARKER.test(text)) return true;
  let hits = 0;
  for (const re of SUMMARY_SECTION_MARKERS) {
    if (re.test(text)) hits += 1;
  }
  return hits >= SUMMARY_HEADER_THRESHOLD;
}

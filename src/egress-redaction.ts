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

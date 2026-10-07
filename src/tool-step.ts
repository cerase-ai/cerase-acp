// The sentence that names the step an assistant is on, for the status line a
// turn shows in the chat (see turn-status.ts).
//
// The control-plane holds the catalogue: a sentence for each tool, and for a
// recipe the gateway runs, a sentence for that recipe. The bridge sends what it
// sees of the tool call, the name it started with and the input it was given,
// and shows the sentence it gets back.
//
// `POST /api/internal/tool-step/{agent}` with the control-plane's bearer and
// `{"tool", "input", "lang"}`; the answer is 200 `{"sentence": "…"}`.

import type { SupportedLang } from "./turn-meta.js";

/**
 * How long the bridge waits for the sentence. The status line is posted after
 * a tool has run four seconds; a slower answer would put it up late, and the
 * bridge's own plain sentence is shown instead.
 */
export const TOOL_STEP_TIMEOUT_MS = 2_000;

/** The longest sentence a status line shows; anything longer is cut. */
const MAX_SENTENCE_CHARS = 300;

export interface ToolStepOptions {
  controlPlaneUrl: string;
  internalSecret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ToolStep {
  /** The tool's name as the call started, e.g. `cerase-gateway_call_recipe`. */
  tool: string;
  /** The tool's input as last reported, `{}` while it is not known yet. */
  input: Record<string, unknown>;
  lang: SupportedLang;
}

/**
 * Ask the control-plane for the sentence of one step. THROWS on anything but a
 * 2xx carrying a non-empty `sentence`, and on a timeout: the caller shows its
 * own plain sentence then.
 */
export async function fetchToolStep(agentId: string, step: ToolStep, opts: ToolStepOptions): Promise<string> {
  const f = opts.fetchImpl ?? fetch;
  const url = `${opts.controlPlaneUrl.replace(/\/$/, "")}/api/internal/tool-step/${encodeURIComponent(agentId)}`;
  const resp = await f(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.internalSecret}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ tool: step.tool, input: step.input, lang: step.lang }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? TOOL_STEP_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`tool-step: HTTP ${resp.status}`);
  const body = (await resp.json()) as { sentence?: unknown };
  const sentence = typeof body.sentence === "string" ? body.sentence.trim() : "";
  if (sentence === "") throw new Error("tool-step: the answer carries no sentence");
  return sentence.length > MAX_SENTENCE_CHARS ? `${sentence.slice(0, MAX_SENTENCE_CHARS - 1)}…` : sentence;
}

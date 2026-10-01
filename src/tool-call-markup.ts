// A final answer that is a tool call written out as text instead of made.
//
// Some turns end with the model emitting its tool-call syntax as ordinary
// message text: the provider did not turn it into a call, so nothing ran, the
// engine saw no call and closed the turn, and the text was the last thing it
// wrote. On the bench it is the final answer of 25 in 8,161 sessions of the
// shipped model at `high`, 24 of them on slide tasks, and of 47 in 1,936 at
// `max`. Sent on, the person reads raw tags where an answer should be.
//
// The shapes below are the ones recorded in those answers, and only those.
// Every one opens with its tag at the start of a line:
//
//   <｜｜DSML｜｜ calls>            DeepSeek's own markers, invoke and parameter
//                                 tags inside, sometimes one bar per side
//   <tool_calls> <function_calls> wrapping <invoke name="…"> and
//                                 <parameter name="…">, or JSON objects
//                                 {"name": …, "arguments": …}
//   <tool_call> <tool_call name=…> wrapping JSON
//   <invoke name="…">             with no wrapper at all
//
// The answer is judged from its first such line to its end. It is markup when
// nothing follows the last tag of that vocabulary, or when it stops inside a
// parameter's value, which is how a cut-off block ends. A block followed by
// prose is left alone, and so is anything inside a code fence: that is how an
// answer quotes the syntax to somebody who asked about it.

import { bridgePromptLine } from "./bridge-prompt.js";

const OPENER = String.raw`(?:<(?:tool_calls|function_calls)\s*>|<tool_call[\s>]|<invoke\s+name=|<[｜|]+\s*DSML\s*[｜|]+)`;

// An opening tag at the start of a line, indentation allowed.
const OPENER_LINE = new RegExp(String.raw`^[ \t]*${OPENER}`, "gm");
const OPENER_AT_START = new RegExp(`^${OPENER}`);

// Every tag, opening or closing, of the recorded vocabulary. What sits
// between the tags is never read: a parameter's value is free text and can
// hold anything, an angle bracket included.
const VOCAB_TAG =
  /<\/?(?:[｜|]+\s*DSML\s*[｜|]+[^<>\n]*|(?:tool_calls|function_calls|tool_call|invoke|parameter)(?:\s[^<>]*)?)>/g;
const PARAMETER_OPEN = /^<(?:[｜|]+\s*DSML\s*[｜|]+\s*)?parameter\b/;
// A tag cut off before its closing bracket, the last thing in the text.
const UNFINISHED_TAG = /^<[^<>\n]*$/;

const FENCE_LINE = /^[ \t]*(?:```|~~~)/gm;

/** Whether a code fence is open at the end of `text`, given whether one was open before it. */
export function fenceOpenAfter(text: string, openBefore: boolean): boolean {
  const fences = text.match(FENCE_LINE)?.length ?? 0;
  return fences % 2 === 1 ? !openBefore : openBefore;
}

/**
 * Where the first line that opens a tool-call block starts, counting only
 * lines outside a code fence, or -1. `insideFence` says whether the text
 * begins inside one, for a caller that sees a message in pieces.
 */
export function toolCallMarkupStart(text: string, insideFence = false): number {
  if (!text) return -1;
  for (const m of text.matchAll(OPENER_LINE)) {
    if (!fenceOpenAfter(text.slice(0, m.index), insideFence)) return m.index;
  }
  return -1;
}

/**
 * Where a streaming caller has to stop sending: the first opening line, or a
 * last line that is still an unfinished tag and may become one once the next
 * piece arrives. Holding such a line costs a delay; sending it cannot be
 * undone.
 */
export function toolCallMarkupHoldStart(text: string, insideFence = false): number {
  const at = toolCallMarkupStart(text, insideFence);
  if (at >= 0) return at;
  const lineStart = text.lastIndexOf("\n") + 1;
  const last = text.slice(lineStart).trimStart();
  if (last.length > 0 && last.length <= 24 && UNFINISHED_TAG.test(last)) {
    if (!fenceOpenAfter(text.slice(0, lineStart), insideFence)) return text.length - last.length;
  }
  return -1;
}

/**
 * Whether `block`, which should start at a line `toolCallMarkupStart` found,
 * is a tool-call block that runs to the end of the text.
 */
export function isToolCallMarkup(block: string): boolean {
  const s = block.trim();
  if (!OPENER_AT_START.test(s)) return false;
  let last: RegExpExecArray | undefined;
  for (const m of s.matchAll(VOCAB_TAG)) last = m;
  if (!last) return false;
  const tail = s.slice(last.index + last[0].length).trim();
  if (last[0].startsWith("</")) return tail === "" || UNFINISHED_TAG.test(tail);
  return PARAMETER_OPEN.test(last[0]) && !tail.includes("\n");
}

/** Whether a whole answer ends in a tool-call block, with or without a sentence before it. */
export function endsInToolCallMarkup(text: string): boolean {
  const at = toolCallMarkupStart(text);
  return at >= 0 && isToolCallMarkup(text.slice(at));
}

/** The first line of the follow-up prompt, which marks it as the bridge's: see bridge-prompt.ts. */
export const MARKUP_RETRY_MARKER = bridgePromptLine("reply", "not sent");

/**
 * The follow-up prompt that gives the assistant its one more try.
 *
 * A second prompt on the same session, for the reason the attach correction
 * is one: ACP carries one prompt in flight per session, and the turn has
 * already ended. It says that nothing ran, because the text named a call —
 * an email sent, a record written — that never happened, and an assistant that
 * believes it did would report work that was not done. It names no tag: a
 * model shown the syntax is a model given it to copy.
 */
export function toolCallMarkupRetryPrompt(): string {
  return [
    MARKUP_RETRY_MARKER,
    "Your last message was not sent to the person: it was a tool call written out as text instead of made through the tool interface, so no tool ran and nothing in it happened.",
    "The person has not seen that message; do not mention it. Continue the request from where it stopped: make any tool call through the tool interface, never as text, and end with your answer to the person in plain words.",
  ].join("\n");
}

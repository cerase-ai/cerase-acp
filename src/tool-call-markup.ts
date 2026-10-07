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
//
// Two more shapes reached a person's chat on 6 October, from a line that opens
// with a tag of any name, and are judged the same way:
//
//   <cerase-ok>                   text made only of tags, with no word between
//                                 or around them, sent twice as a message
//   <cerase-gateway_call_recipe>  a tool call spelled as elements named after
//     <recipe_name>…</recipe_name>  the tool and its arguments: elements whose
//     <args>{…}</args>              content is only elements, to the end
//   </cerase-gateway_call_recipe>
//
// Neither is words for a person. An element with words of its own inside it,
// `<b>Nota</b>`, is not this, and neither is an address in angle brackets.

import { bridgePromptLine } from "./bridge-prompt.js";

const OPENER = String.raw`(?:<(?:tool_calls|function_calls)\s*>|<tool_call[\s>]|<invoke\s+name=|<[｜|]+\s*DSML\s*[｜|]+)`;

// An opening tag at the start of a line, indentation allowed.
const OPENER_LINE = new RegExp(String.raw`^[ \t]*${OPENER}`, "gm");
const OPENER_AT_START = new RegExp(`^${OPENER}`);

// A line that opens with a tag of any name, or with one of DeepSeek's markers:
// where text that is only tags, or a call spelled as elements, can start.
const TAG_LINE = /^[ \t]*<(?:\/?[A-Za-z_]|[｜|])/gm;

// A tag of any name: a name, then attributes, a slash or the closing bracket.
// An address (`<https://…>`, `<mario@rossi.it>`) is not one: its name runs into
// a character no tag name has.
const ANY_TAG = /<\/?[A-Za-z_][\w.:-]*(?:\s[^<>\n]*)?\/?>/g;
const ANY_TAG_PARTS = /^<(\/?)([A-Za-z_][\w.:-]*)(?:\s[^<>\n]*)?(\/?)>$/;

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
  const at = tagLineStart(text, insideFence);
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

/** Where the first line opening with a tag of any name starts, outside a code fence, or -1. */
function tagLineStart(text: string, insideFence: boolean): number {
  if (!text) return -1;
  for (const m of text.matchAll(TAG_LINE)) {
    if (!fenceOpenAfter(text.slice(0, m.index), insideFence)) return m.index;
  }
  return -1;
}

/** Whether `text` is tags and nothing else: no word between, before or after them. */
export function isOnlyTags(text: string): boolean {
  const s = text.trim();
  if (!s.startsWith("<")) return false;
  return s.replace(VOCAB_TAG, "").replace(ANY_TAG, "").trim() === "";
}

/**
 * Whether `text` is elements whose content is only elements, to its end: a
 * tool call spelled as a tag named after the tool, its arguments as children.
 * The outermost elements hold no words of their own; what is inside a child is
 * a value and is not read. A block cut off inside a child counts, as a cut-off
 * call does above.
 */
export function isElementCall(text: string): boolean {
  const s = text.trim();
  if (!s.startsWith("<")) return false;
  const stack: string[] = [];
  let children = 0;
  let last = 0;
  for (const m of s.matchAll(ANY_TAG)) {
    const parts = ANY_TAG_PARTS.exec(m[0]);
    if (!parts) return false;
    const [, closing, name, selfClosing] = parts;
    // Inside a child everything is its value, up to the tag that closes it.
    if (stack.length >= 2 && !(closing && name === stack[stack.length - 1])) continue;
    // Words outside any element, or directly inside an outermost one.
    if (stack.length <= 1 && s.slice(last, m.index).trim() !== "") return false;
    last = m.index + m[0].length;
    if (closing) {
      if (stack.length === 0 || stack[stack.length - 1] !== name) return false;
      stack.pop();
    } else if (!selfClosing) {
      if (stack.length === 1) children += 1;
      stack.push(name!);
    } else if (stack.length === 1) {
      children += 1;
    }
  }
  if (stack.length <= 1 && s.slice(last).trim() !== "") return false;
  return children > 0;
}

/** What a run of text the person must not read is: a call written out, or tags alone. */
export type MarkupKind = "call" | "tags";

/**
 * Where the text stops being words for a person: the first line, outside a code
 * fence, from which everything to the end is a tool call written out in any of
 * the shapes above, or tags alone. -1 when there is none.
 */
export function withheldMarkupStart(text: string, insideFence = false): { at: number; kind: MarkupKind } | null {
  if (!text) return null;
  for (const m of text.matchAll(TAG_LINE)) {
    if (fenceOpenAfter(text.slice(0, m.index), insideFence)) continue;
    const rest = text.slice(m.index);
    if (isToolCallMarkup(rest) || isElementCall(rest)) return { at: m.index, kind: "call" };
    if (isOnlyTags(rest)) return { at: m.index, kind: "tags" };
  }
  return null;
}

/** Whether a whole answer ends in a tool-call block or in tags alone, with or without a sentence before it. */
export function endsInToolCallMarkup(text: string): boolean {
  return withheldMarkupStart(text) !== null;
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
 *
 * One line per paragraph with a blank line between them, as in the attach
 * correction (attachFailurePrompt).
 */
export function toolCallMarkupRetryPrompt(): string {
  return [
    MARKUP_RETRY_MARKER,
    "Your last message was not sent to the person: it was tags or a tool call written out as text instead of made through the tool interface, with no words for them, so no tool ran and nothing in it happened.",
    "The person has not seen that message; do not mention it. Continue the request from where it stopped: make any tool call through the tool interface, never as text, and end with your answer to the person in plain words.",
  ].join("\n\n");
}

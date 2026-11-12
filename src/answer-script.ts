// The rule that holds back the part of an answer whose letters are mostly in
// another writing system than the person's own words, and the one more try the
// bridge gives the assistant in the conversation's language.
//
// The examples are cerase-core's, the file its console suite reads, vendored
// here and pinned in scripts/TOOLING.sha256: the bridge and the console apply
// one rule, so they are held to one set of examples rather than two that could
// drift apart.

import { bridgePromptLine } from "./bridge-prompt.js";
import type { SupportedLang } from "./turn-meta.js";

/** The fewest letters of another script a held part may have and still be withheld. */
export const MIN_OTHER_LETTERS = 12;

// A letter that is not in the Latin script.
const OTHER_SCRIPT_LETTER = /(?!\p{Script=Latin})\p{L}/u;
const ANY_LETTER = /\p{L}/gu;
const LATIN_LETTER = /\p{Script=Latin}/gu;

function letters(text: string): { total: number; latin: number } {
  return {
    total: text.match(ANY_LETTER)?.length ?? 0,
    latin: text.match(LATIN_LETTER)?.length ?? 0,
  };
}

/**
 * Whether the person's own words are written in Latin script: they hold no
 * letter at all, or more than half of their letters are Latin.
 */
export function personWritesLatin(words: string): boolean {
  const { total, latin } = letters(words);
  return total === 0 || latin * 2 > total;
}

/**
 * Where the first line holding a letter outside the Latin script starts, or
 * -1 when no line does.
 */
export function otherScriptLineStart(text: string): number {
  let start = 0;
  for (const line of text.split("\n")) {
    if (OTHER_SCRIPT_LETTER.test(line)) return start;
    start += line.length + 1;
  }
  return -1;
}

/**
 * Where the part of a held answer that is mostly in another writing system
 * starts, or null when there is no such part: the first line holding a letter
 * outside the Latin script, when what runs from there to the end has at least
 * `MIN_OTHER_LETTERS` such letters and they are more than half of its letters.
 */
export function withheldOtherScriptStart(held: string): number | null {
  const at = otherScriptLineStart(held);
  if (at < 0) return null;
  const { total, latin } = letters(held.slice(at));
  const other = total - latin;
  return other >= MIN_OTHER_LETTERS && other * 2 > total ? at : null;
}

/**
 * The answer with the part held back for its writing system left out, its
 * trailing whitespace trimmed, or the answer unchanged when there is none.
 */
export function withoutHeldPart(answer: string): string {
  const at = withheldOtherScriptStart(answer);
  return at === null ? answer : answer.slice(0, at).trimEnd();
}

/** The first line of the follow-up prompt, which marks it as the bridge's: see bridge-prompt.ts. */
export const OTHER_SCRIPT_RETRY_MARKER = bridgePromptLine("reply", "other script");

const LANGUAGE_NAME: Record<SupportedLang, string> = {
  it: "Italian",
  en: "English",
  es: "Spanish",
  fr: "French",
  unknown: "the language the person writes in",
};

/**
 * The follow-up prompt that gives the assistant its one more try after an
 * answer was held back for its writing system.
 *
 * A second prompt on the same session, for the reason the attach correction
 * is one: ACP carries one prompt in flight per session, and the turn has
 * already ended. It names the conversation's language, so the assistant writes
 * its answer again in the person's own script, and it allows the other writing
 * system only when the person asked for it.
 *
 * One line per paragraph with a blank line between them, as in the attach
 * correction (attachFailurePrompt).
 */
export function otherScriptRetryPrompt(lang: SupportedLang): string {
  const language = LANGUAGE_NAME[lang];
  return [
    OTHER_SCRIPT_RETRY_MARKER,
    "Your last message was not sent to the person: most of its letters are in another writing system than the one they write in.",
    `The person has not seen that message; do not mention it. Write it again in ${language} and continue the request from where it stopped. Only if the person asked for text in that other writing system, send that text again, with your words to them in ${language}.`,
  ].join("\n\n");
}

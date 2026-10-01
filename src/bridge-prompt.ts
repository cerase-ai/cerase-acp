// The prompts the bridge sends the assistant on its own, and the one rule that
// tells them apart from every other user message stored in the session.
//
// Some outcomes are known only after the assistant has stopped writing: a file
// it attached did not reach the person, an answer it wrote as a tool call was
// held back. The bridge tells it in a prompt of its own on the same session,
// opencode stores that prompt as a user message, and the console chat, which
// reads the transcript from the session, has to know the person never wrote it.
//
// The rule: such a prompt opens with one line, `[<what>_result: <outcome>]`, at
// the very start of the message. Every prompt that carries somebody's words,
// typed on a channel or in the console or injected by the platform, starts with
// the `[turn_meta: …]` block the bridge prepends to all of them, so nothing a
// person types can be that first line.
//
// cerase-core reads the same rule in `App\Support\BridgePrompt`. Both sides are
// held to the same examples, control-plane/tests/fixtures/bridge-prompts.json:
// cerase-core owns that file, and the copy in this repo is vendored from it and
// pinned in scripts/TOOLING.sha256.

const LINE = String.raw`\[[a-z]+_result: [^\]\n]+\]`;
const OPENS_WITH_LINE = new RegExp(String.raw`^${LINE}\r?(?:\n|$)`);
const IS_LINE = new RegExp(`^${LINE}$`);

/** Whether a stored user message is a prompt the bridge sent on its own. */
export function isBridgePrompt(text: string): boolean {
  return OPENS_WITH_LINE.test(text);
}

/**
 * The first line of a prompt the bridge sends on its own. It refuses a line the
 * rule would not recognise, so a prompt built here cannot reach the console as
 * the person's.
 */
export function bridgePromptLine(what: string, outcome: string): string {
  const line = `[${what}_result: ${outcome}]`;
  if (!IS_LINE.test(line)) throw new Error(`not a line the console recognises as the bridge's: ${line}`);
  return line;
}

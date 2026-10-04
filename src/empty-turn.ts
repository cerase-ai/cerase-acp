// A turn that ends with no text and no tool call: the model stopped on its
// reasoning alone. The service answered, so waiting would not help; the same
// session is asked again at once, with a note telling the assistant to answer
// the person. A provider error is not this case: a failed turn keeps the
// runtime's own backoff and is never tried again here.

import { bridgePromptLine } from "./bridge-prompt.js";

/** How many times an empty turn is tried again before the person is told. */
export const EMPTY_TURN_RETRIES = 3;

/** The first line of the note, which marks it as the bridge's: see bridge-prompt.ts. */
export const EMPTY_TURN_MARKER = bridgePromptLine("reply", "empty");

/**
 * The note that asks the assistant to answer after a turn that said nothing.
 *
 * One line per paragraph with a blank line between them, as in the other
 * prompts the bridge sends on its own (toolCallMarkupRetryPrompt).
 */
export function emptyTurnRetryPrompt(): string {
  return [
    EMPTY_TURN_MARKER,
    "Your last turn ended without a message to the person and without a tool call, so the person has received nothing yet.",
    "Answer the person's last message now: make any tool call the request needs through the tool interface, and end with your answer to the person in plain words.",
  ].join("\n\n");
}

// What an assistant is told on the first turn after its instructions or its
// skills change.
//
// A conversation outlives a release. Its earlier turns hold what the assistant
// wrote and did under the previous instructions, and the model follows those
// turns over a system prompt that now says otherwise: on lt-name-1, with
// v0.1.10-rc.4, a quote's revision was made as the conversation's previous
// quote had been, with no stage of the method read again, and a reply reused a
// draft signed with the person's name, while both new rules were in the system
// prompt. The control-plane knows when an assistant's instructions last changed
// and whether the conversation's last message is older; the bridge says it in
// front of that one turn, as a prompt of its own the console does not show as
// the person's words.

import { bridgePromptLine } from "./bridge-prompt.js";

/** The note, in English like every prompt the platform writes to an assistant. */
export function instructionsChangedNote(): string {
  return [
    bridgePromptLine("instructions", "changed"),
    "Your instructions or your skills changed after the last message of this conversation, so what you wrote and did earlier in it followed the previous ones. From this message on, follow your instructions as they are now over anything earlier in the conversation, and load a skill again before you use it, even one you have used here before.",
  ].join("\n");
}

/** The turn's context with the note in front of it, or the context as it was when nothing changed. */
export function withInstructionsChanged(changed: boolean, context: string | undefined): string | undefined {
  if (!changed) return context;
  return context ? `${instructionsChangedNote()}\n\n${context}` : instructionsChangedNote();
}

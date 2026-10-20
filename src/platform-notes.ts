// What an assistant is told about a notice the platform posted in the person's
// chat.
//
// When a service refuses an account, the control-plane posts the person a
// notice with a «Ricollega» button outside the conversation, so the assistant
// never sees it. Asked later about «the link», it cannot tell which one the
// person means and asks which service. The control-plane leaves a note naming
// the account and the call that sends a new link, hands it over once, and the
// bridge puts it in front of that turn, as it does the note that the
// instructions changed. Unlike that note, it also goes to the first turn of a
// new conversation: the notice is in the chat whichever conversation follows.

import { bridgePromptLine } from "./bridge-prompt.js";

/** The note, in English like every prompt the platform writes to an assistant. */
export function platformNotesNote(notes: string[]): string | undefined {
  if (notes.length === 0) return undefined;
  return [bridgePromptLine("notice", "posted"), notes.join("\n\n")].join("\n");
}

/** The turn's context with the platform's notes in front of it, or the context as it was when there are none. */
export function withPlatformNotes(notes: string[], context: string | undefined): string | undefined {
  const note = platformNotesNote(notes);
  if (!note) return context;
  return context ? `${note}\n\n${context}` : note;
}

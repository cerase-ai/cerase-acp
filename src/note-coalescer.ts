// The notes the platform writes into a conversation that arrive while the
// assistant is answering are given to it together, in its next turn.
//
// Each approval's outcome reaches the assistant as a platform note that starts
// a turn of its own. Five decisions taken one after the other, while the
// assistant was still answering the first, were five turns: five replies,
// each repeating what was still waiting. A note that finds a turn of its
// conversation running now joins the notes waiting for that turn to end, and
// they reach the assistant as one prompt, so it answers once for all of them.
//
// Nothing waits for what has not happened yet. A note that finds the
// conversation idle runs at once, and a batch waits only for the turns that
// were already running when its first note arrived, never for a decision
// still to come and never for a message the person sends afterwards.
//
// Only platform notes are joined. A message the person wrote, a scheduled
// message, anything that does not open with the platform's line, goes through
// exactly as it came.

import type { DeliveryResult } from "./chat-adapter.js";
import { makeLogger } from "./logger.js";

const logger = makeLogger("cerase-acp.note-coalescer");

/**
 * The line every platform note opens with, as the control-plane writes it
 * (`PlatformNote::compose`). The control-plane reads back every signed line
 * of a prompt that opens with one, which is what lets several notes share a
 * turn.
 */
export const PLATFORM_NOTE_PREFIX = "[platform_note sig=";

/** What separates two notes that share a turn. */
export const NOTE_SEPARATOR = "\n\n";

export function isPlatformNote(text: string): boolean {
  return text.startsWith(PLATFORM_NOTE_PREFIX);
}

/** The part of the dispatcher the coalescer drives. */
export interface NoteTurns {
  handleMessage(agentId: string, userId: string, text: string): Promise<DeliveryResult>;
  /**
   * Settles when every turn of the conversation that is running now has
   * ended; null when none is. A dispatcher that cannot answer has every note
   * run at once, as before notes were joined.
   */
  turnsRunning?(agentId: string, userId: string): Promise<void> | null;
}

interface Batch {
  notes: string[];
  result: Promise<DeliveryResult>;
}

export class NoteCoalescer {
  /** Per conversation, the batch still waiting for its turn, if any. */
  private waiting = new Map<string, Batch>();

  constructor(private turns: NoteTurns) {}

  /**
   * Hand `text` to the assistant: at once when it is not a platform note or
   * the conversation is idle, else with the other notes waiting for the turn
   * now running. Every note of a batch resolves to the batch's outcome.
   */
  submit(agentId: string, userId: string, text: string): Promise<DeliveryResult> {
    if (!isPlatformNote(text)) return this.turns.handleMessage(agentId, userId, text);

    const key = `${agentId}:${userId}`;
    const batch = this.waiting.get(key);
    if (batch) {
      batch.notes.push(text);
      return batch.result;
    }

    const running = typeof this.turns.turnsRunning === "function" ? this.turns.turnsRunning(agentId, userId) : null;
    if (running === null) return this.turns.handleMessage(agentId, userId, text);

    const notes = [text];
    const result = running
      .catch(() => undefined)
      .then(() => {
        // Closed before the turn starts, so a note arriving from here on finds
        // this batch's turn running and opens the next one.
        if (this.waiting.get(key)?.notes === notes) this.waiting.delete(key);
        if (notes.length > 1) {
          logger.info({ agentId, userId, notes: notes.length }, "platform notes that waited share one turn");
        }
        return this.turns.handleMessage(agentId, userId, notes.join(NOTE_SEPARATOR));
      });
    this.waiting.set(key, { notes, result });
    return result;
  }
}

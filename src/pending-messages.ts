import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeliveryResult } from "./chat-adapter.js";
import { makeLogger } from "./logger.js";

const logger = makeLogger("cerase-acp.pending-messages");

export const PENDING_MESSAGES_FILE = "pending-messages.json";

/**
 * A message that reached the bridge while it was stopping, as the dispatcher
 * received it: the agent, the person, and the text the adapter built, which
 * already names any file the person attached and the adapter stored in the
 * workspace. That is everything a dispatch needs; the adapter of the next
 * bridge finds the person from their id, as it does for a scheduled message.
 */
export interface PendingMessage {
  id: string;
  agentId: string;
  userId: string;
  text: string;
  /** When a bridge received it from the person, ISO 8601: what orders the list. */
  receivedAt: string;
  /** When the stopping bridge kept it, ISO 8601. */
  keptAt: string;
}

/**
 * The messages a stopping bridge kept for the next one, in the state
 * directory.
 *
 * The file is the only copy. Every change rewrites it whole through a
 * temporary file and a rename, so a bridge killed in the middle of a write
 * leaves the previous list rather than half of one. All of it is synchronous,
 * which is what lets a message be kept, and taken, without another one
 * changing the list in between.
 */
export class PendingMessages {
  constructor(private readonly dir: string | undefined) {}

  /**
   * Add a message to the list, after every message received before it.
   * `undefined` when it could not be written, or when there is no state
   * directory to write it to: a message that is not on disk is not kept.
   *
   * The place comes from when the message was received, not from when it was
   * kept, because the two orders differ: a message queued behind a turn of its
   * conversation is kept only when that turn ends, after any message the same
   * person sent while the bridge was stopping.
   */
  keep(message: { agentId: string; userId: string; text: string; receivedAt: number }): PendingMessage | undefined {
    if (!this.dir) return undefined;
    const kept: PendingMessage = {
      id: randomUUID(),
      agentId: message.agentId,
      userId: message.userId,
      text: message.text,
      receivedAt: new Date(message.receivedAt).toISOString(),
      keptAt: new Date().toISOString(),
    };
    const all = this.list();
    let at = all.length;
    while (at > 0 && Date.parse(all[at - 1]!.receivedAt) > message.receivedAt) at -= 1;
    all.splice(at, 0, kept);
    return this.write(all) ? kept : undefined;
  }

  /** Every message kept and not yet taken, oldest first. */
  list(): PendingMessage[] {
    if (!this.dir) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(this.dir, PENDING_MESSAGES_FILE), "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(
          { reason: (err as Error).message },
          "the messages kept by the previous bridge could not be read; none is answered and the file is replaced on the next write",
        );
      }
      return [];
    }
    const messages = (parsed as { messages?: unknown } | null)?.messages;
    if (!Array.isArray(messages)) return [];
    return messages.filter(isPendingMessage);
  }

  /**
   * Remove a message from the file. True only when this call removed it, so
   * of two callers taking the same message exactly one answers it, and a
   * removal that could not be written answers nothing: answering a message
   * that stays on disk would have the next bridge answer it again.
   */
  take(id: string): boolean {
    const all = this.list();
    const rest = all.filter((m) => m.id !== id);
    if (rest.length === all.length) return false;
    if (this.write(rest)) return true;
    logger.error(
      { id },
      "a kept message could not be taken out of the file, so it is not answered: no bridge answers it twice",
    );
    return false;
  }

  private write(messages: PendingMessage[]): boolean {
    if (!this.dir) return false;
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = join(this.dir, `${PENDING_MESSAGES_FILE}.tmp`);
      writeFileSync(tmp, JSON.stringify({ messages }), { mode: 0o600 });
      renameSync(tmp, join(this.dir, PENDING_MESSAGES_FILE));
      return true;
    } catch (err) {
      logger.error({ reason: (err as Error).message }, "the kept messages could not be written to the state directory");
      return false;
    }
  }
}

function isPendingMessage(m: unknown): m is PendingMessage {
  if (typeof m !== "object" || m === null) return false;
  const { id, agentId, userId, text, receivedAt, keptAt } = m as Record<string, unknown>;
  return (
    typeof id === "string" &&
    typeof agentId === "string" &&
    typeof userId === "string" &&
    typeof text === "string" &&
    typeof receivedAt === "string" &&
    !Number.isNaN(Date.parse(receivedAt)) &&
    typeof keptAt === "string"
  );
}

/**
 * Answer the messages kept for one agent, each at most once.
 *
 * A message is taken out of the file before it is dispatched, never after: a
 * bridge that dies between the two has lost that message, and one that took it
 * afterwards could die having answered it and leave it for the next bridge to
 * answer again. Losing one is the lesser failure.
 *
 * One person's messages go in the order they were sent, each after the turn
 * of the one before has ended, and a message is taken only when its turn is
 * next: one still waiting when this bridge starts to stop stays in the file,
 * where the messages kept by that stop join it in order. Different people do
 * not wait for each other.
 *
 * Resolves to how many messages were dispatched.
 */
export async function replayPending(
  store: PendingMessages,
  agentId: string,
  dispatch: (message: PendingMessage) => Promise<DeliveryResult>,
  stopping: () => boolean,
): Promise<number> {
  const mine = store.list().filter((m) => m.agentId === agentId);
  if (mine.length === 0) return 0;
  const byPerson = new Map<string, PendingMessage[]>();
  for (const m of mine) {
    const queue = byPerson.get(m.userId) ?? [];
    queue.push(m);
    byPerson.set(m.userId, queue);
  }
  logger.info(
    { agentId, messages: mine.length, people: byPerson.size },
    "answering the messages kept while the previous bridge stopped",
  );
  let dispatched = 0;
  await Promise.all(
    [...byPerson.values()].map(async (queue) => {
      for (const m of queue) {
        if (stopping()) return;
        if (!store.take(m.id)) continue;
        dispatched += 1;
        logger.info(
          { agentId, userId: m.userId, receivedAt: m.receivedAt, keptAt: m.keptAt, textLen: m.text.length },
          "answering a message kept while the previous bridge stopped",
        );
        try {
          const result = await dispatch(m);
          if (!result.ok) {
            logger.warn(
              { agentId, userId: m.userId, err: result.error },
              "a kept message was dispatched and its turn did not succeed",
            );
          }
        } catch (err) {
          logger.error({ agentId, userId: m.userId, err }, "a kept message could not be dispatched");
        }
      }
    }),
  );
  return dispatched;
}

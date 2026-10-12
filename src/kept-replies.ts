// The replies a channel could not carry when they were written, kept until it
// can.
//
// A channel can be down while a turn runs with nobody having written into it:
// a note from the platform starts the turn through the internal server, and the
// provider has refused the assistant's bot, or the client has lost its
// connection. The send queue's retries last seconds, and a refusal of that kind
// lasts until somebody fixes it, so the reply was lost. It is kept here instead,
// and the bridge sends it when the channel is back.
//
// The file in the state directory is the copy a restart keeps; without a state
// directory the replies are kept in memory only. Every change rewrites the file
// whole through a temporary file and a rename, as the kept messages are.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeliveryResult } from "./chat-adapter.js";
import { makeLogger } from "./logger.js";

const logger = makeLogger("cerase-acp.kept-replies");

export const KEPT_REPLIES_FILE = "kept-replies.json";

/** One message for a person, as the send path would have handed it to the channel. */
export interface KeptReply {
  id: string;
  agentId: string;
  userId: string;
  text: string;
  /** When it was kept, ISO 8601. */
  keptAt: string;
}

const key = (agentId: string, userId: string) => `${agentId}:${userId}`;

export class KeptReplies {
  private replies: KeptReply[];
  /** The delivery running for each person, which the next one waits for. */
  private readonly running = new Map<string, Promise<number>>();

  constructor(private readonly dir: string | undefined) {
    this.replies = this.read();
  }

  /** Keep a message for a person, after every message kept for them before. */
  keep(agentId: string, userId: string, text: string): KeptReply {
    const reply: KeptReply = { id: randomUUID(), agentId, userId, text, keptAt: new Date().toISOString() };
    this.replies.push(reply);
    this.write();
    return reply;
  }

  /** Whether anything is kept for this person. */
  has(agentId: string, userId: string): boolean {
    return this.replies.some((r) => r.agentId === agentId && r.userId === userId);
  }

  /**
   * Whether anything for this person is kept or being sent. A message taken
   * out of the list to be sent is not in it, and a new one must still wait
   * behind it.
   */
  pending(agentId: string, userId: string): boolean {
    return this.has(agentId, userId) || this.running.has(key(agentId, userId));
  }

  /** The agents anything is kept for. */
  agents(): string[] {
    return [...new Set(this.replies.map((r) => r.agentId))];
  }

  /** The people of one agent anything is kept for. */
  people(agentId: string): string[] {
    return [...new Set(this.replies.filter((r) => r.agentId === agentId).map((r) => r.userId))];
  }

  /** Drop everything kept for an agent that is gone. Answers how many. */
  forget(agentId: string): number {
    const before = this.replies.length;
    this.replies = this.replies.filter((r) => r.agentId !== agentId);
    const dropped = before - this.replies.length;
    if (dropped > 0) this.write();
    return dropped;
  }

  /**
   * Send what is kept for a person, oldest first, through `send`, for as long
   * as `canCarry` says the channel can. Resolves to how many were sent.
   *
   * Each message is taken out of the list before it is sent, never after: a
   * bridge that dies between the two has lost it, and one that took it after
   * could die having sent it and leave it for the next bridge to send again.
   * When the send fails because the channel went again, the message goes back
   * first in line and the delivery stops. When it fails with the channel up,
   * the channel refused that message, and it is dropped rather than tried
   * again at every chance.
   *
   * A second delivery for the same person waits for the one running.
   */
  deliver(
    agentId: string,
    userId: string,
    send: (text: string) => Promise<DeliveryResult>,
    canCarry: () => boolean,
  ): Promise<number> {
    const k = key(agentId, userId);
    const before = this.running.get(k) ?? Promise.resolve(0);
    const run = before.catch(() => 0).then(() => this.deliverNow(agentId, userId, send, canCarry));
    this.running.set(k, run);
    const done = () => {
      if (this.running.get(k) === run) this.running.delete(k);
    };
    run.then(done, done);
    return run;
  }

  private async deliverNow(
    agentId: string,
    userId: string,
    send: (text: string) => Promise<DeliveryResult>,
    canCarry: () => boolean,
  ): Promise<number> {
    let sent = 0;
    for (;;) {
      if (!canCarry()) return sent;
      const at = this.replies.findIndex((r) => r.agentId === agentId && r.userId === userId);
      if (at < 0) return sent;
      const [reply] = this.replies.splice(at, 1) as [KeptReply];
      this.write();
      let result: DeliveryResult;
      try {
        result = await send(reply.text);
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
      }
      if (result.ok) {
        sent += 1;
        logger.info(
          { agentId, userId, keptAt: reply.keptAt, chars: reply.text.length },
          "sent a reply kept while the channel could not carry it",
        );
        continue;
      }
      if (!canCarry()) {
        const next = this.replies.findIndex((r) => r.agentId === agentId && r.userId === userId);
        this.replies.splice(next < 0 ? this.replies.length : next, 0, reply);
        this.write();
        logger.warn(
          { agentId, userId, err: result.error },
          "the channel went again while a kept reply was sent — kept for the next time",
        );
        return sent;
      }
      logger.error(
        { agentId, userId, keptAt: reply.keptAt, err: result.error },
        "the channel is up and refused a kept reply — dropped",
      );
    }
  }

  private read(): KeptReply[] {
    if (!this.dir) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(this.dir, KEPT_REPLIES_FILE), "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(
          { reason: (err as Error).message },
          "the replies kept by the previous bridge could not be read; none is sent and the file is replaced on the next write",
        );
      }
      return [];
    }
    const replies = (parsed as { replies?: unknown } | null)?.replies;
    return Array.isArray(replies) ? replies.filter(isKeptReply) : [];
  }

  private write(): void {
    if (!this.dir) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = join(this.dir, `${KEPT_REPLIES_FILE}.tmp`);
      writeFileSync(tmp, JSON.stringify({ replies: this.replies }), { mode: 0o600 });
      renameSync(tmp, join(this.dir, KEPT_REPLIES_FILE));
    } catch (err) {
      logger.error(
        { reason: (err as Error).message },
        "the kept replies could not be written to the state directory; they are kept in memory until the bridge stops",
      );
    }
  }
}

function isKeptReply(r: unknown): r is KeptReply {
  if (typeof r !== "object" || r === null) return false;
  const { id, agentId, userId, text, keptAt } = r as Record<string, unknown>;
  return (
    typeof id === "string" &&
    typeof agentId === "string" &&
    typeof userId === "string" &&
    typeof text === "string" &&
    typeof keptAt === "string"
  );
}

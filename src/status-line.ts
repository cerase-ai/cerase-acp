// The status line on a channel that edits and deletes its own messages:
// Discord, Telegram and Slack. The first `show` posts the message, every later
// one edits it, and `close` deletes it. When, and with which sentence, is the
// dispatcher's (turn-status.ts); this is only how the one message is kept.
//
// The operations run one after another, in the order they were asked for, so
// an edit never reaches the platform ahead of the post it edits and the delete
// always comes last. A failure is logged and swallowed: the line is a courtesy
// and the answer must not depend on it. A post that fails is not tried again,
// because a post that failed on our side may still have reached the chat, and
// a second one would leave two messages of which only one can be removed.

import type { StatusLine } from "./chat-adapter.js";
import { makeLogger } from "./logger.js";

const logger = makeLogger("cerase-acp.status-line");

/** What a channel does to its own message: post it, edit it, delete it. */
export interface MessageOps<M> {
  post(text: string): Promise<M>;
  edit(message: M, text: string): Promise<void>;
  remove(message: M): Promise<void>;
}

/**
 * A status line kept as one message of the channel's own. `context` goes into
 * every log line it writes.
 */
export function messageStatusLine<M>(ops: MessageOps<M>, context: Record<string, unknown>): StatusLine {
  let chain: Promise<void> = Promise.resolve();
  let message: M | undefined;
  let postTried = false;
  let closed = false;
  const queue = (failure: string, op: () => Promise<void>): Promise<void> => {
    chain = chain.then(op).catch((err: unknown) => {
      logger.warn({ ...context, reason: err instanceof Error ? err.message : String(err) }, failure);
    });
    return chain;
  };
  return {
    show(text: string): Promise<void> {
      if (closed) return chain;
      return queue("status line not posted or edited; the turn goes on without it", async () => {
        if (closed) return;
        if (message !== undefined) {
          await ops.edit(message, text);
          return;
        }
        if (postTried) return;
        postTried = true;
        message = await ops.post(text);
      });
    },
    close(): Promise<void> {
      if (closed) return chain;
      closed = true;
      return queue("status line not deleted; it stays in the chat", async () => {
        if (message === undefined) return;
        const posted = message;
        message = undefined;
        await ops.remove(posted);
      });
    },
  };
}

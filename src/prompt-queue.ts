// Per-session FIFO queue. ACP is single-threaded per session — only one
// `session/prompt` may be in flight at a time. If the user sends turn #2
// while turn #1 is still streaming, we queue it. A failing handler does
// not block the queue: its promise rejects, the next item starts.
//
// A session the bridge ends is flushed: the item running is left to end, and
// every item behind it is refused in its place, so none of them is sent to a
// child that is going away.

type Handler<T> = () => Promise<T>;

interface QueueItem {
  run: () => Promise<void>;
  refuse: (err: Error) => void;
}

export class PromptQueue {
  private items: QueueItem[] = [];
  private inFlight = 0;
  private draining = false;
  private refusal: (() => Error) | undefined;

  enqueue<T>(handler: Handler<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.items.push({
        run: async () => {
          try {
            const value = await handler();
            resolve(value);
          } catch (err) {
            reject(err);
          }
        },
        refuse: reject,
      });
      void this.drain();
    });
  }

  /**
   * Refuse every item that has not started, and every item enqueued from now
   * on, with the error `reason` returns, without running it. Each is refused
   * when its turn comes, after the item running has ended, so the callers see
   * the refusals in the order they queued. `reason` is asked once per item, at
   * that moment.
   */
  flush(reason: () => Error): void {
    this.refusal ??= reason;
    void this.drain();
  }

  size(): number {
    return this.items.length + this.inFlight;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.items.length > 0) {
        const item = this.items.shift()!;
        if (this.refusal) {
          item.refuse(this.refusal());
          continue;
        }
        this.inFlight = 1;
        await item.run();
        this.inFlight = 0;
      }
    } finally {
      this.draining = false;
    }
  }
}

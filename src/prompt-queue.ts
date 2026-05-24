// Per-session FIFO queue. ACP is single-threaded per session — only one
// `session/prompt` may be in flight at a time. If the user sends turn #2
// while turn #1 is still streaming, we queue it. A failing handler does
// not block the queue: its promise rejects, the next item starts.

type Handler<T> = () => Promise<T>;

interface QueueItem {
  run: () => Promise<void>;
}

export class PromptQueue {
  private items: QueueItem[] = [];
  private inFlight = 0;
  private draining = false;

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
      });
      void this.drain();
    });
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
        this.inFlight = 1;
        await item.run();
        this.inFlight = 0;
      }
    } finally {
      this.draining = false;
    }
  }
}

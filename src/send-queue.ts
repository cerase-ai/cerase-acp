// Per-channel FIFO that delivers messages to Discord while respecting:
//   - the 2000-character per-message limit (split on nice boundaries)
//   - the rate-limit (~5 messages/sec on DMs; we space sends ≥100ms)

import { makeLogger } from "./logger.js";

const logger = makeLogger("cerase-acp.send-queue");

// Discord's per-message limit is 2000. We target 1990 to leave room for
// the " ⏎" continuation marker (4 bytes UTF-8) on non-final chunks.
const HARD_LIMIT = 2000;
const CHUNK_BUDGET = 1990;
const CONTINUATION = " ⏎";

/**
 * Splits `text` into Discord-ready chunks. Each chunk except the last
 * carries a trailing `" ⏎"` continuation marker. Empty input returns
 * an empty array (the queue treats it as a no-op).
 */
export function chunkForDiscord(text: string): string[] {
  if (!text) return [];
  if (text.length <= HARD_LIMIT) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > CHUNK_BUDGET) {
    // Prefer the last newline within the budget; fall back to the last
    // sentence terminator; finally hard-split.
    const window = remaining.slice(0, CHUNK_BUDGET);
    let cut = window.lastIndexOf("\n");
    if (cut < CHUNK_BUDGET / 2) {
      cut = Math.max(
        window.lastIndexOf(". "),
        window.lastIndexOf("! "),
        window.lastIndexOf("? "),
      );
      if (cut > 0) cut += 1; // include the terminator
    }
    if (cut < CHUNK_BUDGET / 2) cut = CHUNK_BUDGET;
    chunks.push(remaining.slice(0, cut).trimEnd() + CONTINUATION);
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export interface SendQueueOptions {
  /** Where each chunk is dispatched. Errors are logged + the queue continues. */
  send: (chunk: string) => Promise<void>;
  /** Minimum ms between two `send()` invocations. Default 100. */
  minIntervalMs?: number;
}

/** M-ACP-2: sent once when a chunk is lost after its retry. */
export const DELIVERY_FAILURE_MARKER =
  "⚠️ Parte della risposta non è stata consegnata (errore del canale). / Part of the reply could not be delivered.";

export class SendQueue {
  private failureMarkerQueued = false;

  private items: string[] = [];
  private running = false;
  private lastSentAt = 0;
  private readonly send: (chunk: string) => Promise<void>;
  private readonly minIntervalMs: number;
  private donePromise: Promise<void> = Promise.resolve();
  private resolveDone: (() => void) | undefined;

  constructor(opts: SendQueueOptions) {
    this.send = opts.send;
    this.minIntervalMs = opts.minIntervalMs ?? 100;
  }

  enqueue(text: string): void {
    const chunks = chunkForDiscord(text);
    if (chunks.length === 0) return;
    if (this.items.length === 0 && !this.running) {
      this.donePromise = new Promise<void>((resolve) => {
        this.resolveDone = resolve;
      });
    }
    this.items.push(...chunks);
    void this.drainLoop();
  }

  /** Resolves when the queue is empty AND no send is in flight. */
  drain(): Promise<void> {
    if (this.items.length === 0 && !this.running) return Promise.resolve();
    return this.donePromise;
  }

  private async drainLoop(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.items.length > 0) {
        const wait = this.lastSentAt + this.minIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        const chunk = this.items.shift()!;
        try {
          await this.send(chunk);
        } catch (err) {
          // M-ACP-2: one retry, then a VISIBLE delivery-failure marker
          // (once per queue) instead of a silent hole in the reply.
          logger.warn({ err }, "send-queue: send() threw — retrying once");
          try {
            await this.send(chunk);
          } catch (retryErr) {
            logger.error({ err: retryErr }, "send-queue: retry failed — dropping chunk, emitting marker");
            if (!this.failureMarkerQueued) {
              this.failureMarkerQueued = true;
              this.items.unshift(DELIVERY_FAILURE_MARKER);
            }
          }
        }
        this.lastSentAt = Date.now();
      }
    } finally {
      this.running = false;
      this.resolveDone?.();
      this.resolveDone = undefined;
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

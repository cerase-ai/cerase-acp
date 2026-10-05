// Per-reply FIFO that delivers an answer to the channel while respecting:
//   - Discord's 2000-character per-message limit (split on nice boundaries)
//   - Discord's rate limit (~5 messages/sec on DMs; we space sends ≥100ms)
// A chunk the channel refuses is tried again after each of the backoff delays
// below, and reported with a marker once it has been refused through all of
// them.
// Google Chat allows one write a second in a space, counting the placeholder's
// edit; that pace is kept per space by its API client, below this queue, so a
// Chat send target resolves only once its turn has come. A Chat answer reaches
// the queue whole and is cut by the channel's own `split`, at Google's message
// size instead of Discord's.

import type { DeliveryResult } from "./chat-adapter.js";
import { makeLogger } from "./logger.js";
import { deliveryFailureNotice } from "./platform-notices.js";

const logger = makeLogger("cerase-acp.send-queue");

// Discord's per-message limit is 2000. We target 1990 to leave room for
// the " ⏎" continuation marker (4 bytes UTF-8) on non-final chunks.
const HARD_LIMIT = 2000;
const CHUNK_BUDGET = 1990;
/** Ends every part of a message cut in several but the last. */
export const CONTINUATION = " ⏎";

/**
 * How long a refused chunk waits before each further try, in ms: three retries,
 * each twice as far from the previous one, 3.5 s in all. Long enough for a
 * network blip or a channel's brief refusal to pass, short enough not to hold
 * the rest of the answer. Discord's and Slack's own clients already wait out a
 * rate limit before they report a refusal here; Telegram's does not.
 */
export const SEND_RETRY_DELAYS_MS = [500, 1_000, 2_000];

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
      cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
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
  /**
   * Where each chunk is dispatched. The target returns a `DeliveryResult`
   * instead of throwing on a channel error — a `!ok` result drives the
   * one-retry + visible-marker path below and is recorded so `drain()` can
   * report whether any chunk ultimately failed. A target that still throws
   * is treated defensively as a `!ok` result.
   */
  send: (chunk: string) => Promise<DeliveryResult>;
  /** Minimum ms between two `send()` invocations. Default 100. */
  minIntervalMs?: number;
  /** The notice sent once when a chunk is lost. Defaults to the Italian one. */
  failureMarker?: string;
  /** Cuts one enqueued text into the messages the channel takes. Defaults to `chunkForDiscord`. */
  split?: (text: string) => string[];
  /** The waits before each retry of a refused chunk. Defaults to SEND_RETRY_DELAYS_MS. */
  retryDelaysMs?: number[];
}

/**
 * Sent once when a chunk is lost after its retry.
 *
 * Kept as the default for a queue built without a language -- the CLI and the
 * test ingresses have none. A real turn passes the localised one, because this
 * default used to be the only version anybody saw and it carried two languages
 * in one line.
 */
export const DELIVERY_FAILURE_MARKER = deliveryFailureNotice("unknown");

/**
 * The aggregate outcome of draining the queue. `ok` iff every chunk was
 * delivered, on its first try or a retry; otherwise `failures` carries the
 * chunk + the last error for each chunk that was lost.
 */
export type DrainResult = { ok: true } | { ok: false; failures: Array<{ chunk: string; error: Error }> };

export class SendQueue {
  private failureMarkerQueued = false;
  // Chunks ultimately lost (after the one retry), so
  // drain() can report a truthful aggregate outcome to the dispatcher.
  private failures: Array<{ chunk: string; error: Error }> = [];
  // Chunks the channel took and the send path did not withhold.
  private deliveredCount = 0;

  private items: string[] = [];
  private running = false;
  private lastSentAt = 0;
  private readonly send: (chunk: string) => Promise<DeliveryResult>;
  private readonly minIntervalMs: number;
  private readonly failureMarker: string;
  private readonly split: (text: string) => string[];
  private readonly retryDelaysMs: number[];
  private donePromise: Promise<void> = Promise.resolve();
  private resolveDone: (() => void) | undefined;

  constructor(opts: SendQueueOptions) {
    this.send = opts.send;
    this.minIntervalMs = opts.minIntervalMs ?? 100;
    this.failureMarker = opts.failureMarker ?? DELIVERY_FAILURE_MARKER;
    this.split = opts.split ?? chunkForDiscord;
    this.retryDelaysMs = opts.retryDelaysMs ?? SEND_RETRY_DELAYS_MS;
  }

  enqueue(text: string): void {
    const chunks = this.split(text);
    if (chunks.length === 0) return;
    if (this.items.length === 0 && !this.running) {
      this.donePromise = new Promise<void>((resolve) => {
        this.resolveDone = resolve;
      });
    }
    this.items.push(...chunks);
    void this.drainLoop();
  }

  /**
   * How many chunks reached the person: taken by the channel and not withheld
   * by the send path. A reply whose every chunk was withheld counts none.
   */
  delivered(): number {
    return this.deliveredCount;
  }

  /**
   * Resolves when the queue is empty AND no send is in flight. The resolved
   * value reports whether every chunk was ultimately delivered, so the
   * dispatcher can fail loud on a swallowed delivery failure.
   */
  drain(): Promise<DrainResult> {
    const summarize = (): DrainResult =>
      this.failures.length === 0 ? { ok: true } : { ok: false, failures: [...this.failures] };
    if (this.items.length === 0 && !this.running) return Promise.resolve(summarize());
    return this.donePromise.then(summarize);
  }

  private async drainLoop(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.items.length > 0) {
        const wait = this.lastSentAt + this.minIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        const chunk = this.items.shift()!;
        const result = await this.sendWithRetry(chunk);
        if (result.ok && !result.withheld) this.deliveredCount += 1;
        if (!result.ok) {
          // The chunk is lost after its retries.
          // Record it (so drain() reports the failure) and emit a visible
          // delivery-failure marker once per queue instead of a silent hole.
          logger.error({ err: result.error }, "send-queue: the last retry failed — dropping chunk, emitting marker");
          this.failures.push({ chunk, error: result.error });
          if (!this.failureMarkerQueued) {
            this.failureMarkerQueued = true;
            this.items.unshift(this.failureMarker);
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

  /**
   * One send attempt, and on failure a retry after each backoff delay until
   * one is delivered. Once a chunk of this queue has been lost the channel has
   * refused through the whole backoff, so every later chunk is tried once:
   * waiting the backoff again for each would hold the end of the turn for the
   * length of the answer. The send target returns a DeliveryResult; a target
   * that still throws is caught defensively and treated as a `!ok` result.
   */
  private async sendWithRetry(chunk: string): Promise<DeliveryResult> {
    let result = await this.invokeSend(chunk);
    const delays = this.failures.length > 0 ? [] : this.retryDelaysMs;
    for (const [i, delay] of delays.entries()) {
      if (result.ok) return result;
      logger.warn(
        { err: result.error, retry: i + 1, of: delays.length, delayMs: delay },
        "send-queue: send reported failure — retrying after a backoff",
      );
      await sleep(delay);
      result = await this.invokeSend(chunk);
    }
    return result;
  }

  private async invokeSend(chunk: string): Promise<DeliveryResult> {
    try {
      return await this.send(chunk);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

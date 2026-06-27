// Per-channel FIFO that delivers messages to Discord while respecting:
//   - the 2000-character per-message limit (split on nice boundaries)
//   - the rate-limit (~5 messages/sec on DMs; we space sends ≥100ms)

import type { DeliveryResult } from "./chat-adapter.js";
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
   * Where each chunk is dispatched. M-ACP-FAILLOUD-1: the target now RETURNS
   * a `DeliveryResult` instead of throwing on a channel error — a `!ok`
   * result drives the one-retry + visible-marker path below and is recorded
   * so `drain()` can report whether any chunk ultimately failed. A target
   * that still throws is treated defensively as a `!ok` result.
   */
  send: (chunk: string) => Promise<DeliveryResult>;
  /** Minimum ms between two `send()` invocations. Default 100. */
  minIntervalMs?: number;
}

/** M-ACP-2: sent once when a chunk is lost after its retry. */
export const DELIVERY_FAILURE_MARKER =
  "⚠️ Parte della risposta non è stata consegnata (errore del canale). / Part of the reply could not be delivered.";

/**
 * M-ACP-FAILLOUD-1 — the aggregate outcome of draining the queue. `ok` iff
 * every chunk was delivered (after at most one retry each); otherwise the
 * `failures` carry the chunk + the last error for each chunk that was lost.
 */
export type DrainResult = { ok: true } | { ok: false; failures: Array<{ chunk: string; error: Error }> };

export class SendQueue {
  private failureMarkerQueued = false;
  // M-ACP-FAILLOUD-1: chunks ultimately lost (after the one retry), so
  // drain() can report a truthful aggregate outcome to the dispatcher.
  private failures: Array<{ chunk: string; error: Error }> = [];

  private items: string[] = [];
  private running = false;
  private lastSentAt = 0;
  private readonly send: (chunk: string) => Promise<DeliveryResult>;
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

  /**
   * Resolves when the queue is empty AND no send is in flight. M-ACP-FAILLOUD-1:
   * the resolved value reports whether every chunk was ultimately delivered, so
   * the dispatcher can fail loud on a swallowed delivery failure.
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
        if (!result.ok) {
          // M-ACP-2 / M-ACP-FAILLOUD-1: the chunk is lost after its one retry.
          // Record it (so drain() reports the failure) and emit a VISIBLE
          // delivery-failure marker once per queue instead of a silent hole.
          logger.error({ err: result.error }, "send-queue: retry failed — dropping chunk, emitting marker");
          this.failures.push({ chunk, error: result.error });
          if (!this.failureMarkerQueued) {
            this.failureMarkerQueued = true;
            this.items.unshift(DELIVERY_FAILURE_MARKER);
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
   * M-ACP-2: one send attempt, and on failure exactly one retry (M-ACP-FAILLOUD-1
   * preserves this). The send target now returns a DeliveryResult; a target that
   * still throws is caught defensively and treated as a `!ok` result.
   */
  private async sendWithRetry(chunk: string): Promise<DeliveryResult> {
    const first = await this.invokeSend(chunk);
    if (first.ok) return first;
    logger.warn({ err: first.error }, "send-queue: send reported failure — retrying once");
    return this.invokeSend(chunk);
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

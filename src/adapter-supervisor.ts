// M-ACP-ADAPTER-SELFHEAL-1 — per-adapter retry supervisor.
//
// M-ACP-WEB-RESILIENT-1 (M22) made a single adapter's start() failure
// non-fatal: the channel just stays not-ready while the rest of the bridge
// keeps serving. This module adds the recovery half: when a channel adapter
// fails to start (a bad-then-fixed Discord token, a transient Cloudflare
// ConnectTimeoutError), retry it on a capped, jittered exponential backoff
// until it connects — no container restart, no operator action.
//
// It is deliberately tiny and side-effect-isolated: it owns only timers and an
// attempt counter per agent, and reports recovery/failure through callbacks so
// the bridge can flip getAgentStatus readiness. Best-effort by contract — a
// retry that throws is swallowed and rescheduled; the supervisor never rejects
// or crashes the bridge.

import { makeLogger } from "./logger.js";

const logger = makeLogger("cerase-acp.adapter-supervisor");

/** The slice of a ChatAdapter the supervisor needs to drive a retry. */
export interface SupervisedAdapter {
  agentId: string;
  start(): Promise<void>;
}

export interface AdapterSupervisorOptions {
  /** First retry delay (ms). Doubles each attempt, capped at maxDelayMs. Default 5000. */
  baseDelayMs?: number;
  /** Ceiling for the backoff interval (ms). Default 300_000 (5 min). */
  maxDelayMs?: number;
  /** RNG in [0,1) for jitter; injectable for deterministic tests. Default Math.random. */
  random?: () => number;
  /** Called when a retry succeeds — the bridge clears the not-ready mark. */
  onRecovered: (agentId: string) => void;
  /** Called when a retry attempt fails — the bridge keeps the not-ready mark. */
  onStillFailing?: (agentId: string, err: unknown) => void;
}

export class AdapterSupervisor {
  private readonly base: number;
  private readonly max: number;
  private readonly random: () => number;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly attempts = new Map<string, number>();
  private stopped = false;

  constructor(private readonly opts: AdapterSupervisorOptions) {
    this.base = opts.baseDelayMs ?? 5000;
    this.max = opts.maxDelayMs ?? 300_000;
    this.random = opts.random ?? Math.random;
  }

  /**
   * (Jittered) backoff for the Nth retry (1-based): `base * 2^(n-1)` capped at
   * `max`, then half-jittered into `[50%, 100%]` of that so a fleet of adapters
   * failing at once doesn't reconnect in lockstep (thundering herd).
   */
  backoffMs(attempt: number): number {
    const raw = this.base * 2 ** (attempt - 1);
    const capped = Math.min(raw, this.max);
    return Math.round(capped * (0.5 + 0.5 * this.random()));
  }

  /**
   * Schedule a backoff retry for an adapter that just failed to start. Each
   * call advances the backoff for that agent. A retry already pending for the
   * agent is replaced (the latest call wins).
   */
  scheduleRetry(adapter: SupervisedAdapter): void {
    if (this.stopped) return;
    const existing = this.timers.get(adapter.agentId);
    if (existing) clearTimeout(existing);

    const attempt = (this.attempts.get(adapter.agentId) ?? 0) + 1;
    this.attempts.set(adapter.agentId, attempt);
    const delay = this.backoffMs(attempt);
    logger.warn({ agentId: adapter.agentId, attempt, delayMs: delay }, "adapter self-heal: retry scheduled");

    const timer = setTimeout(() => {
      this.timers.delete(adapter.agentId);
      void this.attempt(adapter);
    }, delay);
    this.timers.set(adapter.agentId, timer);
  }

  private async attempt(adapter: SupervisedAdapter): Promise<void> {
    if (this.stopped) return;
    try {
      await adapter.start();
      this.attempts.delete(adapter.agentId);
      logger.info({ agentId: adapter.agentId }, "adapter self-heal: recovered");
      this.opts.onRecovered(adapter.agentId);
    } catch (err) {
      logger.error({ err, agentId: adapter.agentId }, "adapter self-heal: retry failed — rescheduling");
      this.opts.onStillFailing?.(adapter.agentId, err);
      this.scheduleRetry(adapter);
    }
  }

  /** Is a retry currently pending for this agent? (diagnostic / tests) */
  isScheduled(agentId: string): boolean {
    return this.timers.has(agentId);
  }

  /** Cancel every pending retry. Called from bridge shutdown / total-failure teardown. */
  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.attempts.clear();
  }
}

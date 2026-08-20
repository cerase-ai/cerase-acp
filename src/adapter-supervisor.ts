// Per-adapter retry supervisor.
//
// A single adapter's start() failure is non-fatal: the channel just stays
// not-ready while the rest of the bridge keeps serving. This module adds the
// recovery half: when a channel adapter
// fails to start (a bad-then-fixed Discord token, a transient Cloudflare
// ConnectTimeoutError), retry it on a capped, jittered exponential backoff
// until it connects — no container restart, no operator action.
//
// It is deliberately tiny and side-effect-isolated: it owns only timers and an
// attempt counter per agent, and reports recovery/failure through callbacks so
// the bridge can flip getAgentStatus readiness. Best-effort by contract — a
// retry that throws is swallowed and rescheduled; the supervisor never rejects
// or crashes the bridge.
//
// Not every failure is worth retrying. A credential the provider refuses will
// be refused again, so the loop hides a dead assistant behind the appearance
// of recovery in progress. Such a failure is terminal here: the timers stop,
// the reason is recorded per agent, and the bridge reports it on
// /internal/status. See credential-rejection.ts for which codes qualify.

import { type CredentialRejection, classifyCredentialRejection } from "./credential-rejection.js";
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
  /**
   * Called once, when a failure is final and the retries for that agent have
   * stopped. The bridge records the reason so a person reading
   * /internal/status sees which assistant is down and which credential the
   * provider refused. Without this the stop would be as silent as the loop.
   */
  onTerminal?: (agentId: string, rejection: CredentialRejection) => void;
  /**
   * Decides whether a start() failure is final. Injectable for tests; the
   * default is the credential-rejection table.
   */
  classify?: (err: unknown) => CredentialRejection | undefined;
}

export class AdapterSupervisor {
  private readonly base: number;
  private readonly max: number;
  private readonly random: () => number;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly attempts = new Map<string, number>();
  /** agentId to the refusal that stopped its retries. Cleared by noteStarted. */
  private readonly terminal = new Map<string, CredentialRejection>();
  private readonly classify: (err: unknown) => CredentialRejection | undefined;
  private stopped = false;

  constructor(private readonly opts: AdapterSupervisorOptions) {
    this.base = opts.baseDelayMs ?? 5000;
    this.max = opts.maxDelayMs ?? 300_000;
    this.random = opts.random ?? Math.random;
    this.classify = opts.classify ?? classifyCredentialRejection;
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
   *
   * Pass the failure as `err` when the caller has it — the boot loop caught
   * the first one itself — so a refused credential is recognised before the
   * first timer is armed rather than one backoff later. An agent already
   * marked terminal is never re-armed, whether or not `err` is passed;
   * noteStarted is what lets it retry again.
   */
  scheduleRetry(adapter: SupervisedAdapter, err?: unknown): void {
    if (this.stopped) return;
    const rejection = err === undefined ? undefined : this.classify(err);
    if (rejection) {
      this.markTerminal(adapter.agentId, rejection);
      return;
    }
    if (this.terminal.has(adapter.agentId)) return;
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
      this.noteStarted(adapter.agentId);
      logger.info({ agentId: adapter.agentId }, "adapter self-heal: recovered");
      this.opts.onRecovered(adapter.agentId);
    } catch (err) {
      this.opts.onStillFailing?.(adapter.agentId, err);
      const rejection = this.classify(err);
      if (rejection) {
        this.markTerminal(adapter.agentId, rejection);
        return;
      }
      logger.error({ err, agentId: adapter.agentId }, "adapter self-heal: retry failed — rescheduling");
      this.scheduleRetry(adapter);
    }
  }

  /**
   * Record a final failure and stop retrying this agent. Idempotent: the
   * bridge may report the same refusal from the boot loop and from a retry,
   * and a person must not read that as two separate incidents.
   */
  private markTerminal(agentId: string, rejection: CredentialRejection): void {
    const existing = this.timers.get(agentId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(agentId);
    }
    this.attempts.delete(agentId);
    if (this.terminal.has(agentId)) return;
    this.terminal.set(agentId, rejection);
    logger.error(
      { agentId, code: rejection.code, credential: rejection.credential, detail: rejection.detail },
      "adapter self-heal: the channel provider refused this agent's credential — retries stopped, this assistant is DOWN until the credential is fixed",
    );
    this.opts.onTerminal?.(agentId, rejection);
  }

  /**
   * The adapter for this agent started. Drops the backoff and any terminal
   * record, so a corrected credential is not still reported as refused after
   * a config reload put it back in service.
   */
  noteStarted(agentId: string): void {
    this.cancel(agentId);
  }

  /**
   * Stop supervising this agent and drop everything remembered about it.
   *
   * Called when an agent leaves agents.yaml. A retry left armed for it would
   * fire against the adapter the bridge has already stopped and dropped, log
   * in a client for an assistant nobody configured any more, and leave it
   * running: the bridge's shutdown stops the adapters it holds, and this one
   * is not among them.
   */
  cancel(agentId: string): void {
    const existing = this.timers.get(agentId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(agentId);
    }
    this.attempts.delete(agentId);
    this.terminal.delete(agentId);
  }

  /** The refusal that stopped this agent's retries, if it has one. */
  terminalFailure(agentId: string): CredentialRejection | undefined {
    return this.terminal.get(agentId);
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

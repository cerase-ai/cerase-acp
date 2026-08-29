// Whether the chat provider is actually answering this adapter.
//
// The bridge already had a readiness signal and it was a cached flag:
// discord.js `client.isReady()` is the client's own view of its own socket,
// updated when the library notices something. A container that lost its
// network kept reporting a ready Discord adapter for five minutes, through
// `/healthz` and `/internal/status` both, with nothing logged. Nothing was
// broken — the adapter reconnected on its own — but an alert wired to `ready`
// would not have fired, and an operator reading either surface during the
// outage would have been told the bridge was fine.
//
// A cached flag can never answer that question, so this module measures
// instead: it remembers when the provider last answered, refreshes that by
// asking it on a slow timer, and reports the age. Readiness then means the
// client believes it is connected AND the provider has answered recently,
// which is what every reader of `ready` already assumed it meant.
//
// The measurement is deliberately cheap and deliberately slow. One unauth'd
// GET per adapter per minute costs nothing and stays far away from any rate
// limit, and every message the adapter successfully sends or receives counts
// as the same evidence, so a busy bridge barely probes at all.

/** What the monitor knows about the provider right now. */
export interface ReachabilitySnapshot {
  /** Epoch ms of the last confirmed answer, or null when none ever came. */
  lastContactAt: number | null;
  /** Ms since that answer, or null when nothing has answered yet. */
  ageMs: number | null;
  /** The provider has been silent for longer than the monitor tolerates. */
  stale: boolean;
}

export interface ReachabilityMonitorOptions {
  /**
   * Ask the provider something cheap. Resolving is the evidence; what it
   * resolves to is ignored. Rejecting is not evidence of an outage on its own
   * — one refused request is ordinary — it simply leaves the age growing.
   */
  probe: () => Promise<unknown>;
  /** How often to ask. Default 60s. */
  intervalMs?: number;
  /**
   * How long the provider may stay silent before readiness turns false.
   * Default 180s — three missed probes, so a single blip cannot flip it,
   * and the five-minute outage that prompted this would have been reported
   * with two minutes still to run.
   */
  staleAfterMs?: number;
  /** How long one probe may take before it counts as unanswered. Default: one interval. */
  timeoutMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Called once when the provider goes silent, not once per tick. */
  onStale?: (snapshot: ReachabilitySnapshot) => void;
  /** Called once when it answers again. */
  onRecovered?: (snapshot: ReachabilitySnapshot) => void;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_STALE_AFTER_MS = 180_000;

/**
 * Race `promise` against a deadline. A network that has gone away does not
 * always refuse a connection — it can simply never answer — so a probe with
 * no deadline is a probe that can hang for the whole outage and never report
 * one.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("reachability probe timed out")), ms);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export class ReachabilityMonitor {
  private readonly probe: () => Promise<unknown>;
  private readonly intervalMs: number;
  private readonly staleAfterMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly onStale?: (snapshot: ReachabilitySnapshot) => void;
  private readonly onRecovered?: (snapshot: ReachabilitySnapshot) => void;

  private lastContactAt: number | null = null;
  private timer?: NodeJS.Timeout;
  private probing = false;
  /** The last state the callbacks were told about, so a transition fires once. */
  private reportedStale = false;

  constructor(options: ReachabilityMonitorOptions) {
    this.probe = options.probe;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.timeoutMs = options.timeoutMs ?? this.intervalMs;
    this.now = options.now ?? Date.now;
    this.onStale = options.onStale;
    this.onRecovered = options.onRecovered;
  }

  /**
   * Record that the provider answered. Called by the probe, and by the
   * adapter on any real traffic — a delivered message and an inbound one are
   * both stronger evidence than the probe, and free.
   */
  note(): void {
    this.lastContactAt = this.now();
    this.announce();
  }

  /** Begin probing. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // The probe must never be the reason a process refuses to exit.
    this.timer.unref?.();
  }

  /** Stop probing. The recorded contact time is kept. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  snapshot(): ReachabilitySnapshot {
    const at = this.lastContactAt;
    if (at === null) {
      // Nothing has answered yet, and that is not the same as silence: at boot
      // there has been no time to ask. Readiness falls back to the client's
      // own view until the first answer establishes a baseline.
      return { lastContactAt: null, ageMs: null, stale: false };
    }
    const ageMs = Math.max(0, this.now() - at);
    return { lastContactAt: at, ageMs, stale: ageMs > this.staleAfterMs };
  }

  private async tick(): Promise<void> {
    if (!this.probing) {
      this.probing = true;
      try {
        await withTimeout(this.probe(), this.timeoutMs);
        this.note();
      } catch {
        // Deliberately silent per failure. One refused request says nothing;
        // the age says everything, and announce() below reads it.
      } finally {
        this.probing = false;
      }
    }
    this.announce();
  }

  /** Tell the callbacks about a change of state, and only about a change. */
  private announce(): void {
    const snapshot = this.snapshot();
    if (snapshot.stale === this.reportedStale) return;
    this.reportedStale = snapshot.stale;
    if (snapshot.stale) this.onStale?.(snapshot);
    else this.onRecovered?.(snapshot);
  }
}

/**
 * The readiness an adapter reports: the client says it holds a live
 * connection, and the provider has answered inside the tolerance.
 *
 * Both halves are needed and neither is redundant. The client flag catches a
 * socket the library knows it lost; the measurement catches the case the flag
 * cannot see, which is the library believing a dead socket is alive. An
 * adapter with no monitor at all keeps the old meaning.
 */
export function isChannelReady(clientReady: boolean, reachability?: ReachabilitySnapshot): boolean {
  if (!clientReady) return false;
  return !reachability?.stale;
}

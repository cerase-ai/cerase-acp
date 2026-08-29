// Discord "is typing…" keepalive (M18).
//
// Discord's typing indicator auto-stops ~10s after the last
// `channel.sendTyping()` and immediately when WE send a message in
// the same channel. To keep "Claudia is typing…" visible for the
// duration of an LLM round-trip (5–15s nominal, occasionally
// longer with tool-call intermediates) we refresh it every 7s.
//
// STOPPING AND CLEARING ARE TWO DIFFERENT ACTS, and only one of them
// is ours. `clearInterval` stops the refreshes; nothing in Discord's
// API takes the indicator down. The only clear is the message we send
// in that channel — so the message has to be the last thing Discord
// hears, and any refresh that reaches Discord after it puts the
// indicator back up for another ~10s. That is why `stop()` resolves
// only once the refresh it may have left in flight has landed: an
// unawaited `sendTyping()` issued milliseconds before a send can
// still overtake it on the wire.
//
// This module is intentionally Discord-agnostic at the type level:
// it takes a minimal `{ sendTyping(): Promise<unknown> }` shape so
// vitest can drive it with a plain fake. discord.js's `DMChannel`
// and `TextChannel` both satisfy this shape.

export interface TypingTarget {
  sendTyping(): Promise<unknown>;
}

/**
 * Ends a keepalive. Resolves once no refresh is in flight any more, so a
 * caller that awaits it before sending a message knows Discord has already
 * seen every refresh this keepalive will ever issue.
 */
export type StopTyping = () => Promise<void>;

export interface TypingKeepaliveOptions {
  /** Refresh cadence. Default 7000ms (Discord auto-stops at ~10s). */
  intervalMs?: number;
  /**
   * Safety ceiling on how many refreshes the keepalive will fire
   * before it self-terminates. Default 42 → ~5 minutes of typing
   * indicator, after which a hung turn stops looking like
   * "still thinking" and starts looking pathological. The caller
   * (`stopFn`) should be the normal exit path; this is a guard
   * for cases where the turn coordinator forgets to call it.
   */
  maxTicks?: number;
}

/**
 * Start refreshing the Discord typing indicator on `target`. Returns
 * a `stopFn` the caller invokes in a `finally` block once the turn
 * finishes (success, dispatch throw, allowlist refusal, anything).
 *
 * Calls `sendTyping()` once immediately so the indicator appears
 * within the first frame after the user sends their message. After
 * that, refreshes every `intervalMs`. Each call's promise is
 * `catch()`'d locally — a transient Discord blip on one tick must
 * not surface as an unhandled rejection (which Node would log
 * loudly and which might crash the bridge on `--unhandled-rejections=strict`).
 *
 * The returned `stopFn` resolves when the last issued refresh has settled;
 * it is idempotent, and awaiting it twice is as cheap as awaiting it once.
 */
export function startTypingKeepalive(target: TypingTarget, options?: TypingKeepaliveOptions): StopTyping {
  const intervalMs = options?.intervalMs ?? 7000;
  const maxTicks = options?.maxTicks ?? 42;
  // The refresh most recently handed to the channel, already stripped of its
  // rejection. Awaiting it is what turns "stop refreshing" into "Discord has
  // seen everything I will ever say about typing".
  let inFlight: Promise<void> = Promise.resolve();
  const refresh = () => {
    inFlight = target.sendTyping().then(
      () => {},
      () => {},
    );
  };
  // Immediate call — don't make the user wait `intervalMs` for the
  // indicator to first appear.
  refresh();
  let ticks = 0;
  const id: NodeJS.Timeout = setInterval(() => {
    if (++ticks > maxTicks) {
      clearInterval(id);
      return;
    }
    refresh();
  }, intervalMs);
  return () => {
    clearInterval(id);
    return inFlight;
  };
}

/**
 * The keepalives a channel adapter currently has running, one per
 * conversation key (the platform user id).
 *
 * It exists because the two halves of the turn live in different closures:
 * the message handler starts the keepalive, and the send target — built
 * per turn by the dispatcher, with no reference to the handler — is where
 * the indicator has to come down. Routing both through this registry is
 * what lets the send path end the keepalive BEFORE it hands the message to
 * the channel, instead of the turn coordinator ending it afterwards.
 *
 * `end` is deliberately terminal for the turn: once a turn has delivered
 * anything, its typing indicator is never raised again. Restarting it after
 * a chunk would put a refresh back on the wire with no way of knowing
 * whether another chunk is coming, and whenever it was the last chunk that
 * refresh is exactly the ghost this registry exists to prevent.
 */
export class TypingSessions {
  private readonly active = new Map<string, StopTyping>();

  /**
   * Start a keepalive for `key`, replacing (and ending) any it already had.
   * The returned stop function is the caller's own exit path and removes the
   * session, so a turn that delivers nothing still leaves nothing running.
   */
  start(key: string, target: TypingTarget, options?: TypingKeepaliveOptions): StopTyping {
    void this.end(key);
    const stop = startTypingKeepalive(target, options);
    this.active.set(key, stop);
    return () => {
      // Only the owner clears the slot: a stale stop function from a previous
      // turn must not cancel the registry entry of the current one.
      if (this.active.get(key) === stop) this.active.delete(key);
      return stop();
    };
  }

  /**
   * End the keepalive for `key` and resolve once its last refresh has landed.
   * A key with nothing running resolves immediately — the send path calls this
   * on every message, including ones no inbound DM started.
   */
  end(key: string): Promise<void> {
    const stop = this.active.get(key);
    if (!stop) return Promise.resolve();
    this.active.delete(key);
    return stop();
  }

  /** Whether a keepalive is currently running for `key`. */
  isRunning(key: string): boolean {
    return this.active.has(key);
  }
}

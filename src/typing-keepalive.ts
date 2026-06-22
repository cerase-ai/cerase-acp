// Discord "is typing…" keepalive (M18).
//
// Discord's typing indicator auto-stops ~10s after the last
// `channel.sendTyping()` and immediately when WE send a message in
// the same channel. To keep "Claudia is typing…" visible for the
// duration of an LLM round-trip (5–15s nominal, occasionally
// longer with tool-call intermediates) we refresh it every 7s.
//
// This module is intentionally Discord-agnostic at the type level:
// it takes a minimal `{ sendTyping(): Promise<unknown> }` shape so
// vitest can drive it with a plain fake. discord.js's `DMChannel`
// and `TextChannel` both satisfy this shape.

export interface TypingTarget {
  sendTyping(): Promise<unknown>;
}

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
 */
export function startTypingKeepalive(target: TypingTarget, options?: TypingKeepaliveOptions): () => void {
  const intervalMs = options?.intervalMs ?? 7000;
  const maxTicks = options?.maxTicks ?? 42;
  // Immediate call — don't make the user wait `intervalMs` for the
  // indicator to first appear.
  void target.sendTyping().catch(() => {});
  let ticks = 0;
  const id: NodeJS.Timeout = setInterval(() => {
    if (++ticks > maxTicks) {
      clearInterval(id);
      return;
    }
    void target.sendTyping().catch(() => {});
  }, intervalMs);
  return () => clearInterval(id);
}

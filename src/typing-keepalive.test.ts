import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startTypingKeepalive } from "./typing-keepalive.js";

class FakeTarget {
  calls = 0;
  shouldReject = false;
  async sendTyping(): Promise<void> {
    this.calls += 1;
    if (this.shouldReject) throw new Error("simulated network blip");
  }
}

describe("startTypingKeepalive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls sendTyping once immediately on start", async () => {
    const target = new FakeTarget();
    const stop = startTypingKeepalive(target);
    // Allow the synchronous microtask queue to drain so the
    // immediate-call promise has actually fired sendTyping.
    await Promise.resolve();
    expect(target.calls).toBe(1);
    stop();
  });

  it("calls sendTyping every intervalMs while running", async () => {
    const target = new FakeTarget();
    const stop = startTypingKeepalive(target, { intervalMs: 1000 });
    await Promise.resolve(); // immediate call
    expect(target.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(target.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(target.calls).toBe(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(target.calls).toBe(4);
    stop();
  });

  it("stopFn halts the keepalive — no more calls after stop", async () => {
    const target = new FakeTarget();
    const stop = startTypingKeepalive(target, { intervalMs: 1000 });
    await Promise.resolve();
    expect(target.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(target.calls).toBe(2);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(target.calls).toBe(2); // no further calls
  });

  it("maxTicks bounds the keepalive at the configured ceiling", async () => {
    const target = new FakeTarget();
    // 3 ticks → 3 calls beyond the initial one. After that, no more.
    const stop = startTypingKeepalive(target, { intervalMs: 100, maxTicks: 3 });
    await Promise.resolve(); // immediate call → 1
    await vi.advanceTimersByTimeAsync(100); // tick 1 → 2
    await vi.advanceTimersByTimeAsync(100); // tick 2 → 3
    await vi.advanceTimersByTimeAsync(100); // tick 3 → 4
    await vi.advanceTimersByTimeAsync(100); // tick 4 → bounded, no call
    await vi.advanceTimersByTimeAsync(100); // tick 5 → bounded, no call
    expect(target.calls).toBe(4);
    stop();
  });

  it("swallows sendTyping rejections silently (no unhandled promise)", async () => {
    const target = new FakeTarget();
    target.shouldReject = true;
    // The keepalive must keep running after a rejection; otherwise one
    // transient Discord blip would freeze the indicator for the rest
    // of the turn. The `unhandledRejection` listener catches anything
    // the helper failed to swallow.
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", handler);
    try {
      const stop = startTypingKeepalive(target, { intervalMs: 100 });
      // Flush microtasks (immediate call + its caught rejection)
      // without scheduling a real-timer wait — under fake timers
      // setTimeout is itself faked.
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      stop();
      expect(unhandled).toEqual([]);
      expect(target.calls).toBeGreaterThanOrEqual(2);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });
});

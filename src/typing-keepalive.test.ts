import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTypingKeepalive, TypingSessions } from "./typing-keepalive.js";

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

  it("a stop that catches a rejected refresh still resolves", async () => {
    // The stop function is awaited on the send path. A refresh that fails
    // must not turn that await into a rejection, or one transient blip would
    // lose the whole chunk it was ordering.
    const target = new FakeTarget();
    target.shouldReject = true;
    const stop = startTypingKeepalive(target, { intervalMs: 100 });
    await expect(stop()).resolves.toBeUndefined();
  });
});

// A stand-in for the discord.js DM channel, carrying the only two calls that
// decide what the user sees and recording them in ONE log, in the order
// Discord would receive them. A refresh can be held pending so the test
// chooses the moment it lands — which is the question here, since a refresh
// issued before a message and never waited on can still arrive after it.
class FakeChannel {
  log: string[] = [];
  holdTyping = false;
  private held: Array<() => void> = [];

  sendTyping(): Promise<void> {
    if (!this.holdTyping) {
      this.log.push("typing");
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.held.push(() => {
        this.log.push("typing");
        resolve();
      });
    });
  }

  async send(_text: string): Promise<void> {
    this.log.push("send");
  }

  /** Let every held refresh reach the channel now. */
  landHeldTyping(): void {
    const pending = this.held;
    this.held = [];
    for (const land of pending) land();
  }
}

describe("TypingSessions — the reply is what ends the indicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // The send path the Discord adapter runs: end the turn's keepalive, then
  // hand the message to the channel. Both awaited, in that order.
  async function deliver(sessions: TypingSessions, key: string, channel: FakeChannel, text: string): Promise<void> {
    await sessions.end(key);
    await channel.send(text);
  }

  it("no refresh reaches the channel after the message", async () => {
    const sessions = new TypingSessions();
    const channel = new FakeChannel();
    sessions.start("u1", channel, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(channel.log).toEqual(["typing", "typing", "typing", "typing"]);

    await deliver(sessions, "u1", channel, "the reply");
    // Far past both the refresh cadence and Discord's own auto-stop window:
    // an assertion that the clear happens EVENTUALLY is satisfied by that
    // timeout, which is the thing that made the ghost visible in the first
    // place. What is asserted is the ORDER against the send.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(channel.log.filter((e) => e === "send")).toHaveLength(1);
    expect(channel.log.lastIndexOf("typing")).toBeLessThan(channel.log.indexOf("send"));
    expect(channel.log.at(-1)).toBe("send");
  });

  it("a refresh already in flight lands before the message, never after", async () => {
    const sessions = new TypingSessions();
    const channel = new FakeChannel();
    channel.holdTyping = true;
    sessions.start("u1", channel, { intervalMs: 1000 });

    const delivered = deliver(sessions, "u1", channel, "the reply");
    // The refresh is on the wire and has not landed. The send is waiting on
    // it: this is the ordering an unawaited stop gets wrong.
    await Promise.resolve();
    await Promise.resolve();
    expect(channel.log).toEqual([]);

    channel.landHeldTyping();
    await delivered;
    expect(channel.log).toEqual(["typing", "send"]);
  });

  it("the indicator is not raised again for the rest of the turn", async () => {
    const sessions = new TypingSessions();
    const channel = new FakeChannel();
    sessions.start("u1", channel, { intervalMs: 1000 });
    await deliver(sessions, "u1", channel, "first chunk");
    await vi.advanceTimersByTimeAsync(30_000);
    await deliver(sessions, "u1", channel, "second chunk");
    await vi.advanceTimersByTimeAsync(30_000);

    expect(channel.log).toEqual(["typing", "send", "send"]);
    expect(sessions.isRunning("u1")).toBe(false);
  });

  it("ending a key with nothing running is a no-op the send path can always make", async () => {
    const sessions = new TypingSessions();
    const channel = new FakeChannel();
    await deliver(sessions, "nobody", channel, "an injected message");
    expect(channel.log).toEqual(["send"]);
  });

  it("a second turn for the same user replaces the first keepalive", async () => {
    const sessions = new TypingSessions();
    const first = new FakeChannel();
    const second = new FakeChannel();
    sessions.start("u1", first, { intervalMs: 1000 });
    sessions.start("u1", second, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);

    // The first keepalive stopped the moment the second turn began. Two
    // intervals on one conversation would keep refreshing past whichever of
    // them the send path ends.
    expect(first.log).toEqual(["typing"]);
    expect(second.log).toEqual(["typing", "typing", "typing", "typing"]);
  });

  it("the stop function from start resolves only after the in-flight refresh", async () => {
    const sessions = new TypingSessions();
    const channel = new FakeChannel();
    channel.holdTyping = true;
    const stop = sessions.start("u1", channel, { intervalMs: 1000 });

    let settled = false;
    const stopped = stop().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    channel.landHeldTyping();
    await stopped;
    expect(settled).toBe(true);
    expect(sessions.isRunning("u1")).toBe(false);
  });
});

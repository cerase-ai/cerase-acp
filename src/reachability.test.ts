import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isChannelReady, ReachabilityMonitor } from "./reachability.js";

// A provider that can be told to answer, refuse, or go silent without ever
// answering — the third being the shape of the outage this module exists for:
// the container lost its network and the requests neither succeeded nor
// failed, they just stopped coming back.
class FakeProvider {
  mode: "answers" | "refuses" | "silent" = "answers";
  calls = 0;

  probe = (): Promise<unknown> => {
    this.calls += 1;
    if (this.mode === "answers") return Promise.resolve({ url: "wss://gateway" });
    if (this.mode === "refuses") return Promise.reject(new Error("ENETUNREACH"));
    return new Promise(() => {});
  };
}

describe("ReachabilityMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const build = (provider: FakeProvider, over: Partial<ConstructorParameters<typeof ReachabilityMonitor>[0]> = {}) =>
    new ReachabilityMonitor({
      probe: provider.probe,
      intervalMs: 1000,
      staleAfterMs: 3000,
      now: () => Date.now(),
      ...over,
    });

  it("reports nothing known before the provider has ever answered", () => {
    const monitor = build(new FakeProvider());
    expect(monitor.snapshot()).toEqual({ lastContactAt: null, ageMs: null, stale: false });
  });

  it("stays fresh while the provider answers", async () => {
    const provider = new FakeProvider();
    const monitor = build(provider);
    monitor.note();
    monitor.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(provider.calls).toBeGreaterThanOrEqual(9);
    expect(monitor.snapshot().stale).toBe(false);
    expect(monitor.snapshot().ageMs).toBeLessThanOrEqual(1000);
    monitor.stop();
  });

  it("goes stale once the provider has been silent past the tolerance", async () => {
    const provider = new FakeProvider();
    const monitor = build(provider);
    monitor.note();
    monitor.start();
    provider.mode = "refuses";

    await vi.advanceTimersByTimeAsync(2000);
    expect(monitor.snapshot().stale).toBe(false); // one blip is not an outage
    await vi.advanceTimersByTimeAsync(2000);
    expect(monitor.snapshot().stale).toBe(true);
    expect(monitor.snapshot().ageMs).toBeGreaterThanOrEqual(4000);
    monitor.stop();
  });

  it("a probe that never comes back counts as silence, not as pending", async () => {
    const provider = new FakeProvider();
    const monitor = build(provider, { timeoutMs: 500 });
    monitor.note();
    monitor.start();
    provider.mode = "silent";

    await vi.advanceTimersByTimeAsync(5000);
    expect(monitor.snapshot().stale).toBe(true);
    // The timeout also releases the slot, so the monitor keeps asking rather
    // than waiting for ever on the first request that hung.
    expect(provider.calls).toBeGreaterThan(1);
    monitor.stop();
  });

  it("announces the outage once and the recovery once", async () => {
    const provider = new FakeProvider();
    const stale: number[] = [];
    const recovered: number[] = [];
    const monitor = build(provider, {
      onStale: (s) => stale.push(s.ageMs ?? -1),
      onRecovered: (s) => recovered.push(s.ageMs ?? -1),
    });
    monitor.note();
    monitor.start();

    provider.mode = "refuses";
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stale).toHaveLength(1);
    expect(recovered).toHaveLength(0);

    provider.mode = "answers";
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stale).toHaveLength(1);
    expect(recovered).toHaveLength(1);
    monitor.stop();
  });

  it("real traffic is evidence too, so a busy adapter never goes stale on a slow probe", async () => {
    const provider = new FakeProvider();
    provider.mode = "refuses";
    const monitor = build(provider);
    monitor.note();
    monitor.start();

    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      monitor.note(); // a delivered message
    }
    expect(monitor.snapshot().stale).toBe(false);
    monitor.stop();
  });

  it("stop() ends the probing", async () => {
    const provider = new FakeProvider();
    const monitor = build(provider);
    monitor.note();
    monitor.start();
    await vi.advanceTimersByTimeAsync(3000);
    const before = provider.calls;
    monitor.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(provider.calls).toBe(before);
  });
});

describe("isChannelReady", () => {
  const fresh = { lastContactAt: 1, ageMs: 10, stale: false };
  const silent = { lastContactAt: 1, ageMs: 300_000, stale: true };

  it("a client that reports a dropped connection is never ready", () => {
    expect(isChannelReady(false, fresh)).toBe(false);
    expect(isChannelReady(false, silent)).toBe(false);
  });

  it("a client that reports a live connection is ready while the provider answers", () => {
    expect(isChannelReady(true, fresh)).toBe(true);
  });

  it("a client that reports a live connection while nothing answers is NOT ready", () => {
    // This is the measured case: five minutes of no network, the client still
    // reporting a live socket, and both status surfaces answering that the
    // adapter was fine.
    expect(isChannelReady(true, silent)).toBe(false);
  });

  it("an adapter with no monitor keeps the old meaning", () => {
    expect(isChannelReady(true, undefined)).toBe(true);
    expect(isChannelReady(false, undefined)).toBe(false);
  });
});

describe("the outage that prompted this", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("five minutes with no network flips readiness, where the cached flag did not", async () => {
    const provider = new FakeProvider();
    const monitor = new ReachabilityMonitor({ probe: provider.probe, intervalMs: 60_000, staleAfterMs: 180_000 });
    monitor.note();
    monitor.start();
    // discord.js kept answering `true` throughout, so that half is held fixed
    // and the verdict has to come from the measurement.
    const clientSaysReady = true;

    expect(isChannelReady(clientSaysReady, monitor.snapshot())).toBe(true);
    provider.mode = "silent";
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(isChannelReady(clientSaysReady, monitor.snapshot())).toBe(false);

    // And it comes back on its own when the network does, which is what the
    // adapter actually did.
    provider.mode = "answers";
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(isChannelReady(clientSaysReady, monitor.snapshot())).toBe(true);
    monitor.stop();
  });
});

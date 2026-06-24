import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterSupervisor, type SupervisedAdapter } from "./adapter-supervisor.js";

// A SupervisedAdapter whose start() outcome follows a scripted plan. The Nth
// start() call (0-based) uses plan[min(N, len-1)] — so a trailing "ok" sticks.
function makeAdapter(agentId: string, plan: Array<"ok" | "fail">): SupervisedAdapter & { startCalls: number } {
  const state = {
    agentId,
    startCalls: 0,
    async start() {
      const outcome = plan[Math.min(state.startCalls, plan.length - 1)];
      state.startCalls += 1;
      if (outcome === "fail") throw new Error(`fail ${agentId} #${state.startCalls}`);
    },
  };
  return state;
}

describe("AdapterSupervisor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a failed start after the base backoff and reports recovery", async () => {
    const recovered: string[] = [];
    const sup = new AdapterSupervisor({
      baseDelayMs: 1000,
      maxDelayMs: 300_000,
      random: () => 1, // no jitter shrink → delay == capped
      onRecovered: (id) => recovered.push(id),
    });
    const adapter = makeAdapter("discordy", ["ok"]);

    sup.scheduleRetry(adapter); // the bridge already made (and lost) attempt #0
    expect(adapter.startCalls).toBe(0); // nothing fires before the backoff elapses
    expect(sup.isScheduled("discordy")).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(adapter.startCalls).toBe(1);
    expect(recovered).toEqual(["discordy"]);
    expect(sup.isScheduled("discordy")).toBe(false);
  });

  it("reschedules with exponential backoff while retries keep failing", async () => {
    const recovered: string[] = [];
    const sup = new AdapterSupervisor({
      baseDelayMs: 1000,
      maxDelayMs: 300_000,
      random: () => 1,
      onRecovered: (id) => recovered.push(id),
    });
    const adapter = makeAdapter("discordy", ["fail", "fail", "ok"]);

    sup.scheduleRetry(adapter);
    await vi.advanceTimersByTimeAsync(1000); // retry #1 → fail, reschedule (2000)
    expect(adapter.startCalls).toBe(1);
    expect(recovered).toEqual([]);

    await vi.advanceTimersByTimeAsync(2000); // retry #2 → fail, reschedule (4000)
    expect(adapter.startCalls).toBe(2);

    await vi.advanceTimersByTimeAsync(4000); // retry #3 → ok
    expect(adapter.startCalls).toBe(3);
    expect(recovered).toEqual(["discordy"]);
    expect(sup.isScheduled("discordy")).toBe(false);
  });

  it("caps the backoff at maxDelayMs and applies half-jitter", () => {
    const sup = new AdapterSupervisor({
      baseDelayMs: 5000,
      maxDelayMs: 20_000,
      random: () => 1,
      onRecovered: () => {},
    });
    expect(sup.backoffMs(1)).toBe(5000);
    expect(sup.backoffMs(2)).toBe(10_000);
    expect(sup.backoffMs(3)).toBe(20_000);
    expect(sup.backoffMs(4)).toBe(20_000); // capped
    expect(sup.backoffMs(50)).toBe(20_000); // capped, no overflow

    // Half-jitter: random()=0 → 50% of the capped delay; random()=~1 → 100%.
    const lo = new AdapterSupervisor({ baseDelayMs: 5000, maxDelayMs: 20_000, random: () => 0, onRecovered: () => {} });
    expect(lo.backoffMs(1)).toBe(2500);
  });

  it("stop() cancels pending retries — no further start() afterwards", async () => {
    const recovered: string[] = [];
    const sup = new AdapterSupervisor({
      baseDelayMs: 1000,
      random: () => 1,
      onRecovered: (id) => recovered.push(id),
    });
    const adapter = makeAdapter("discordy", ["ok"]);

    sup.scheduleRetry(adapter);
    sup.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(adapter.startCalls).toBe(0);
    expect(recovered).toEqual([]);
    expect(sup.isScheduled("discordy")).toBe(false);
  });

  it("isolates retries per adapter — one agent's failure does not touch another", async () => {
    const recovered: string[] = [];
    const sup = new AdapterSupervisor({
      baseDelayMs: 1000,
      random: () => 1,
      onRecovered: (id) => recovered.push(id),
    });
    const a = makeAdapter("a", ["ok"]);
    const b = makeAdapter("b", ["fail", "ok"]);

    sup.scheduleRetry(a);
    sup.scheduleRetry(b);
    await vi.advanceTimersByTimeAsync(1000); // a recovers; b fails → reschedules (2000)
    expect(recovered).toEqual(["a"]);
    expect(a.startCalls).toBe(1);
    expect(b.startCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(2000); // b recovers
    expect(recovered).toEqual(["a", "b"]);
    expect(b.startCalls).toBe(2);
  });
});

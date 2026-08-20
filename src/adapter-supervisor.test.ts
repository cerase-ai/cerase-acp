import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterSupervisor, type SupervisedAdapter } from "./adapter-supervisor.js";
import type { CredentialRejection } from "./credential-rejection.js";

/** A discord.js error as it reaches the supervisor: an Error carrying a `code`. */
function discordError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/** An adapter whose start() always rejects with the same error. */
function makeAlwaysFailing(agentId: string, err: unknown): SupervisedAdapter & { startCalls: number } {
  const state = {
    agentId,
    startCalls: 0,
    async start() {
      state.startCalls += 1;
      throw err;
    },
  };
  return state;
}

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

  it("stops retrying a credential the provider rejected, naming the agent and the credential", async () => {
    const terminal: Array<{ agentId: string; rejection: CredentialRejection }> = [];
    const sup = new AdapterSupervisor({
      baseDelayMs: 1000,
      maxDelayMs: 300_000,
      random: () => 1,
      onRecovered: () => {},
      onTerminal: (agentId, rejection) => terminal.push({ agentId, rejection }),
    });
    const adapter = makeAlwaysFailing("agent-10", discordError("TokenInvalid", "An invalid token was provided."));

    sup.scheduleRetry(adapter);
    await vi.advanceTimersByTimeAsync(1000); // retry 1 reaches the provider and is refused
    expect(adapter.startCalls).toBe(1);

    // The measured window on the running bridge was two hours and thirty
    // retries. Nothing may fire in it.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(adapter.startCalls).toBe(1);
    expect(sup.isScheduled("agent-10")).toBe(false);

    expect(terminal).toHaveLength(1);
    expect(terminal[0].agentId).toBe("agent-10");
    expect(terminal[0].rejection.code).toBe("TokenInvalid");
    expect(terminal[0].rejection.credential).toBe("bot_token");
    expect(sup.terminalFailure("agent-10")?.code).toBe("TokenInvalid");
  });

  it("never arms a timer when the very first start() failure is a rejected credential", async () => {
    const terminal: string[] = [];
    const sup = new AdapterSupervisor({
      baseDelayMs: 1000,
      random: () => 1,
      onRecovered: () => {},
      onTerminal: (agentId) => terminal.push(agentId),
    });
    const err = discordError("TokenInvalid", "An invalid token was provided.");
    const adapter = makeAlwaysFailing("agent-10", err);

    // The bridge hands the supervisor the boot failure it already caught.
    sup.scheduleRetry(adapter, err);
    expect(sup.isScheduled("agent-10")).toBe(false);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(adapter.startCalls).toBe(0);
    expect(terminal).toEqual(["agent-10"]);
  });

  it("treats a privileged intent the application lacks as terminal", async () => {
    const terminal: CredentialRejection[] = [];
    const sup = new AdapterSupervisor({
      baseDelayMs: 1000,
      random: () => 1,
      onRecovered: () => {},
      onTerminal: (_agentId, rejection) => terminal.push(rejection),
    });
    const adapter = makeAlwaysFailing(
      "agent-11",
      discordError("DisallowedIntents", "Privileged intent provided is not enabled or whitelisted."),
    );

    sup.scheduleRetry(adapter);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(adapter.startCalls).toBe(1);
    expect(terminal.map((r) => r.code)).toEqual(["DisallowedIntents"]);
  });

  it("keeps retrying a transport failure, which can stop being true on its own", async () => {
    const terminal: string[] = [];
    const stillFailing: string[] = [];
    const sup = new AdapterSupervisor({
      baseDelayMs: 1000,
      random: () => 1,
      onRecovered: () => {},
      onStillFailing: (agentId) => stillFailing.push(agentId),
      onTerminal: (agentId) => terminal.push(agentId),
    });
    const adapter = makeAlwaysFailing("agent-12", discordError("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error"));

    sup.scheduleRetry(adapter);
    await vi.advanceTimersByTimeAsync(1000); // retry 1
    await vi.advanceTimersByTimeAsync(2000); // retry 2
    await vi.advanceTimersByTimeAsync(4000); // retry 3
    expect(adapter.startCalls).toBe(3);
    expect(terminal).toEqual([]);
    expect(stillFailing).toEqual(["agent-12", "agent-12", "agent-12"]);
    expect(sup.isScheduled("agent-12")).toBe(true);
  });

  it("reports a terminal failure once, however many times the bridge asks for a retry", async () => {
    const terminal: string[] = [];
    const sup = new AdapterSupervisor({
      baseDelayMs: 1000,
      random: () => 1,
      onRecovered: () => {},
      onTerminal: (agentId) => terminal.push(agentId),
    });
    const err = discordError("TokenInvalid", "An invalid token was provided.");
    const adapter = makeAlwaysFailing("agent-10", err);

    sup.scheduleRetry(adapter, err);
    sup.scheduleRetry(adapter, err);
    sup.scheduleRetry(adapter); // no error passed: the agent is already terminal
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(adapter.startCalls).toBe(0);
    expect(terminal).toEqual(["agent-10"]);
  });

  it("noteStarted clears the terminal record so a corrected credential is not still reported down", async () => {
    const sup = new AdapterSupervisor({
      baseDelayMs: 1000,
      random: () => 1,
      onRecovered: () => {},
    });
    const err = discordError("TokenInvalid", "An invalid token was provided.");
    const bad = makeAlwaysFailing("agent-10", err);

    sup.scheduleRetry(bad, err);
    expect(sup.terminalFailure("agent-10")).toBeDefined();

    // The operator fixed agents.yaml and the reload restarted this agent.
    sup.noteStarted("agent-10");
    expect(sup.terminalFailure("agent-10")).toBeUndefined();

    // And the supervisor will retry it again if it drops later.
    const good = makeAdapter("agent-10", ["ok"]);
    sup.scheduleRetry(good);
    await vi.advanceTimersByTimeAsync(1000);
    expect(good.startCalls).toBe(1);
  });
});

// Tests for the auto-reload glue in runBridge — bridge.ts wires
// ConfigReloader → diffConfigs → applyConfigDiff so that
// agents.yaml mutations land on the live adapters Map + SessionManager
// without restarting the bridge process.
//
// We exercise applyConfigDiff directly (faster + more focused than
// driving the full ConfigReloader through real file writes — the
// reloader itself is covered in config-reloader.test.ts).

import { describe, expect, it } from "vitest";
import { applyConfigDiff } from "./bridge.js";
import type { ChatAdapter } from "./chat-adapter.js";
import type { AgentConfig, BridgeConfig } from "./config.js";
import { diffConfigs } from "./config-diff.js";
import type { Dispatcher } from "./dispatcher.js";

interface FakeAdapter extends ChatAdapter {
  startCalls: number;
  stopCalls: number;
}

function makeFakeAdapter(agent: AgentConfig): FakeAdapter {
  const state: FakeAdapter = {
    agentId: agent.id,
    startCalls: 0,
    stopCalls: 0,
    async start() {
      state.startCalls += 1;
    },
    async stop() {
      state.stopCalls += 1;
    },
    makeSendTarget() {
      return async () => {
        /* no-op in tests */
        // M-ACP-FAILLOUD-1: the send target reports a delivery outcome.
        return { ok: true };
      };
    },
  };
  return state;
}

interface FakeSessionManager {
  added: string[];
  removed: string[];
  killed: string[];
  allowlistUpdates: Array<{ agentId: string; allowed_users: string[] }>;
  addAgent(a: AgentConfig): void;
  removeAgent(id: string): void;
  killAgentSessions(id: string): void;
  updateAllowlist(id: string, allowed_users: string[]): void;
}

function makeFakeSessionManager(): FakeSessionManager {
  const fsm: FakeSessionManager = {
    added: [],
    removed: [],
    killed: [],
    allowlistUpdates: [],
    addAgent(a) {
      fsm.added.push(a.id);
    },
    removeAgent(id) {
      fsm.removed.push(id);
    },
    killAgentSessions(id) {
      fsm.killed.push(id);
    },
    updateAllowlist(id, allowed_users) {
      fsm.allowlistUpdates.push({ agentId: id, allowed_users: [...allowed_users] });
    },
  };
  return fsm;
}

function baseAgent(id: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id,
    bot_token: `tok-${id}`,
    allowed_users: [`u-${id}`],
    cwd: "/home/agent/cerase/workspace",
    spawn: { command: "docker", args: ["exec", "-i", `cerase-agent-${id}`, "opencode", "acp"] },
    ...overrides,
  };
}

function cfg(agents: AgentConfig[]): BridgeConfig {
  return {
    agents,
    session: { idle_timeout_minutes: 60, max_concurrent: 16 },
  };
}

const fakeDispatcher = {} as unknown as Dispatcher;

describe("applyConfigDiff", () => {
  it("ADDED agent → creates adapter, starts it, registers on sessionManager", async () => {
    const adapters = new Map<string, FakeAdapter>();
    const sm = makeFakeSessionManager();

    const prev = cfg([]);
    const next = cfg([baseAgent("alpha")]);
    await applyConfigDiff(diffConfigs(prev, next), {
      next,
      sessionManager: sm,
      adapters,
      createAdapter: async (a) => makeFakeAdapter(a),
      dispatcher: fakeDispatcher,
    });

    expect(sm.added).toEqual(["alpha"]);
    expect(adapters.size).toBe(1);
    expect(adapters.get("alpha")!.startCalls).toBe(1);
  });

  it("REMOVED agent → stops + drops adapter, calls sessionManager.removeAgent", async () => {
    const sm = makeFakeSessionManager();
    const adapters = new Map<string, FakeAdapter>();
    adapters.set("alpha", makeFakeAdapter(baseAgent("alpha")));

    const prev = cfg([baseAgent("alpha")]);
    const next = cfg([]);
    await applyConfigDiff(diffConfigs(prev, next), {
      next,
      sessionManager: sm,
      adapters,
      createAdapter: async (a) => makeFakeAdapter(a),
      dispatcher: fakeDispatcher,
    });

    expect(sm.removed).toEqual(["alpha"]);
    expect(adapters.has("alpha")).toBe(false);
  });

  it("MODIFIED allowed_users_only → no adapter churn, only updateAllowlist call", async () => {
    const sm = makeFakeSessionManager();
    const existing = makeFakeAdapter(baseAgent("alpha"));
    const adapters = new Map<string, FakeAdapter>();
    adapters.set("alpha", existing);

    const prev = cfg([baseAgent("alpha", { allowed_users: ["u-1"] })]);
    const next = cfg([baseAgent("alpha", { allowed_users: ["u-1", "u-2"] })]);
    await applyConfigDiff(diffConfigs(prev, next), {
      next,
      sessionManager: sm,
      adapters,
      createAdapter: async (a) => makeFakeAdapter(a),
      dispatcher: fakeDispatcher,
    });

    expect(sm.allowlistUpdates).toEqual([{ agentId: "alpha", allowed_users: ["u-1", "u-2"] }]);
    expect(sm.killed).toEqual([]);
    expect(sm.removed).toEqual([]);
    // Same adapter reference, no new start/stop.
    expect(adapters.get("alpha")).toBe(existing);
    expect(existing.stopCalls).toBe(0);
    expect(existing.startCalls).toBe(0);
  });

  it("MODIFIED bot_token_or_spawn → stop old adapter, kill sessions, create new adapter + start", async () => {
    const sm = makeFakeSessionManager();
    const oldAdapter = makeFakeAdapter(baseAgent("alpha"));
    const adapters = new Map<string, FakeAdapter>();
    adapters.set("alpha", oldAdapter);

    const prev = cfg([baseAgent("alpha", { bot_token: "old" })]);
    const next = cfg([baseAgent("alpha", { bot_token: "new" })]);
    await applyConfigDiff(diffConfigs(prev, next), {
      next,
      sessionManager: sm,
      adapters,
      createAdapter: async (a) => makeFakeAdapter(a),
      dispatcher: fakeDispatcher,
    });

    expect(oldAdapter.stopCalls).toBe(1);
    expect(sm.killed).toEqual(["alpha"]);
    const fresh = adapters.get("alpha")!;
    expect(fresh).not.toBe(oldAdapter);
    expect(fresh.startCalls).toBe(1);
  });

  it("MIXED diff (bot_token + allowed_users) → respawn path (mixed treated as bot_token_or_spawn superset)", async () => {
    const sm = makeFakeSessionManager();
    const oldAdapter = makeFakeAdapter(baseAgent("alpha"));
    const adapters = new Map<string, FakeAdapter>();
    adapters.set("alpha", oldAdapter);

    const prev = cfg([baseAgent("alpha", { bot_token: "old", allowed_users: ["u-1"] })]);
    const next = cfg([baseAgent("alpha", { bot_token: "new", allowed_users: ["u-1", "u-2"] })]);
    await applyConfigDiff(diffConfigs(prev, next), {
      next,
      sessionManager: sm,
      adapters,
      createAdapter: async (a) => makeFakeAdapter(a),
      dispatcher: fakeDispatcher,
    });

    expect(oldAdapter.stopCalls).toBe(1);
    expect(sm.killed).toEqual(["alpha"]);
    expect(adapters.get("alpha")!.startCalls).toBe(1);
  });

  it("Empty diff (no changes) → no adapter / sessionManager calls", async () => {
    const sm = makeFakeSessionManager();
    const adapters = new Map<string, FakeAdapter>();
    adapters.set("alpha", makeFakeAdapter(baseAgent("alpha")));

    const same = cfg([baseAgent("alpha")]);
    await applyConfigDiff(diffConfigs(same, same), {
      next: same,
      sessionManager: sm,
      adapters,
      createAdapter: async (a) => makeFakeAdapter(a),
      dispatcher: fakeDispatcher,
    });

    expect(sm.added).toEqual([]);
    expect(sm.removed).toEqual([]);
    expect(sm.killed).toEqual([]);
    expect(sm.allowlistUpdates).toEqual([]);
  });

  it("Composite diff (add + remove + modify on different agents) all applied in one pass", async () => {
    const sm = makeFakeSessionManager();
    const adapters = new Map<string, FakeAdapter>();
    const aOld = makeFakeAdapter(baseAgent("alpha"));
    const bOld = makeFakeAdapter(baseAgent("beta"));
    adapters.set("alpha", aOld);
    adapters.set("beta", bOld);

    const prev = cfg([baseAgent("alpha"), baseAgent("beta", { allowed_users: ["x"] })]);
    const next = cfg([
      // alpha removed
      baseAgent("beta", { allowed_users: ["x", "y"] }), // allowed_users_only
      baseAgent("gamma"), // added
    ]);
    await applyConfigDiff(diffConfigs(prev, next), {
      next,
      sessionManager: sm,
      adapters,
      createAdapter: async (a) => makeFakeAdapter(a),
      dispatcher: fakeDispatcher,
    });

    // alpha removed
    expect(sm.removed).toEqual(["alpha"]);
    expect(adapters.has("alpha")).toBe(false);
    expect(aOld.stopCalls).toBe(1);
    // beta: allowed_users update, no adapter churn
    expect(sm.allowlistUpdates).toEqual([{ agentId: "beta", allowed_users: ["x", "y"] }]);
    expect(adapters.get("beta")).toBe(bOld);
    expect(bOld.startCalls).toBe(0);
    // gamma added
    expect(sm.added).toEqual(["gamma"]);
    expect(adapters.has("gamma")).toBe(true);
    expect(adapters.get("gamma")!.startCalls).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import { type ApplyConfigDiffDeps, applyConfigDiff } from "./bridge.js";
import type { ChatAdapter } from "./chat-adapter.js";
import type { AgentConfig, BridgeConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";

// M-ACP-2 — applyConfigDiff resilience: one agent's createAdapter()
// failure used to abort the WHOLE reload (remaining agents never
// processed). Now: bounded retry per agent, then continue with the
// rest — a single mistyped bot token must not freeze fleet reloads.

function agent(id: string): AgentConfig {
  return {
    id,
    channel: "discord",
    bot_token: "x",
    allowed_users: ["1"],
    cwd: "/home/agent/cerase/workspace",
    spawn: { command: "true", args: [] },
  } as unknown as AgentConfig;
}

function fakeAdapter(id: string): ChatAdapter {
  return {
    agentId: id,
    start: async () => {},
    stop: async () => {},
    makeSendTarget: () => async () => {},
  } as unknown as ChatAdapter;
}

function makeDeps(createAdapter: ApplyConfigDiffDeps["createAdapter"], agents: AgentConfig[]): ApplyConfigDiffDeps {
  return {
    next: { agents, session: { idle_timeout_minutes: 60, max_concurrent: 16 } } as BridgeConfig,
    sessionManager: {
      addAgent: () => {},
      removeAgent: () => {},
      killAgentSessions: () => {},
      updateAllowlist: () => {},
    },
    adapters: new Map(),
    createAdapter,
    dispatcher: {} as Dispatcher,
  };
}

describe("applyConfigDiff resilience (M-ACP-2)", () => {
  it("a failing createAdapter for one added agent does not abort the others", async () => {
    const created: string[] = [];
    const deps = makeDeps(
      async (a) => {
        if (a.id === "bad") throw new Error("invalid bot token");
        created.push(a.id);
        return fakeAdapter(a.id);
      },
      [agent("bad"), agent("good")],
    );

    await applyConfigDiff({ added: [agent("bad"), agent("good")], removed: [], modified: [] }, deps);

    expect(created).toContain("good");
    expect(deps.adapters.has("good")).toBe(true);
    expect(deps.adapters.has("bad")).toBe(false);
  });

  it("retries a transiently failing createAdapter once", async () => {
    let attempts = 0;
    const deps = makeDeps(
      async (a) => {
        attempts++;
        if (attempts === 1) throw new Error("transient");
        return fakeAdapter(a.id);
      },
      [agent("flaky")],
    );

    await applyConfigDiff({ added: [agent("flaky")], removed: [], modified: [] }, deps);

    expect(attempts).toBe(2);
    expect(deps.adapters.has("flaky")).toBe(true);
  });

  it("a failing respawn for a modified agent does not abort the reload", async () => {
    const deps = makeDeps(
      async (a) => {
        if (a.id === "bad") throw new Error("nope");
        return fakeAdapter(a.id);
      },
      [agent("bad"), agent("good")],
    );
    deps.adapters.set("bad", fakeAdapter("bad"));
    deps.adapters.set("good", fakeAdapter("good"));

    await applyConfigDiff(
      {
        added: [],
        removed: [],
        modified: [
          { agentId: "bad", classification: "bot_token_or_spawn" },
          { agentId: "good", classification: "bot_token_or_spawn" },
        ],
      },
      deps,
    );

    expect(deps.adapters.has("good")).toBe(true);
  });
});

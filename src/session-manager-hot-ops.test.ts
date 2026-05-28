// Hot-ops tests for SessionManager (M-auto-reload v0.2):
// addAgent, removeAgent, killAgentSessions, updateAllowlist.
//
// These verify the surface the ConfigReloader will call on every
// agents.yaml change. The shared BridgeConfig is mutated in place so
// downstream consumers (Dispatcher / allowlist.isAllowed) see the
// updated state without needing a config-passing refactor.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { AgentConfig, BridgeConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { isAllowed } from "./allowlist.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

function fakeAgent(id: string, overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id,
    bot_token: `tok-${id}`,
    allowed_users: [`u-${id}-1`],
    cwd: "/home/agent/cerase/workspace",
    spawn: { command: "env", args: ["--", "FAKE_REPLY=ok", "node", FAKE_CHILD] },
    ...overrides,
  };
}

function emptyConfig(): BridgeConfig {
  return {
    agents: [],
    session: { idle_timeout_minutes: 60, max_concurrent: 16 },
  };
}

describe("SessionManager hot ops", () => {
  let mgr: SessionManager;
  let config: BridgeConfig;

  beforeEach(() => {
    config = emptyConfig();
    mgr = new SessionManager(config);
  });

  afterEach(async () => {
    await mgr.shutdown();
  });

  describe("addAgent", () => {
    it("makes a newly added agent addressable via prompt()", async () => {
      const a = fakeAgent("alpha");
      mgr.addAgent(a);

      const result = await mgr.prompt("alpha", "u-alpha-1", "hi");
      expect(result.stopReason).toBeDefined();
    });

    it("mutates the shared BridgeConfig so allowlist.isAllowed sees the new agent", () => {
      mgr.addAgent(fakeAgent("alpha"));
      expect(config.agents.map((a) => a.id)).toEqual(["alpha"]);
      expect(isAllowed(config, "alpha", "u-alpha-1")).toBe(true);
    });

    it("throws when an agent with the same id is already known", () => {
      mgr.addAgent(fakeAgent("alpha"));
      expect(() => mgr.addAgent(fakeAgent("alpha"))).toThrow(/already/i);
    });
  });

  describe("removeAgent", () => {
    it("drops the agent from the shared config + from agentsById", () => {
      mgr.addAgent(fakeAgent("alpha"));
      mgr.addAgent(fakeAgent("beta"));

      mgr.removeAgent("alpha");

      expect(config.agents.map((a) => a.id)).toEqual(["beta"]);
      // prompting a removed agent must now error
      return expect(mgr.prompt("alpha", "u-alpha-1", "hi")).rejects.toThrow(/unknown agent/i);
    });

    it("kills any in-flight session for the removed agent", async () => {
      mgr.addAgent(fakeAgent("alpha"));
      await mgr.prompt("alpha", "u-alpha-1", "hi");
      expect(mgr.activeSessionCount()).toBe(1);

      mgr.removeAgent("alpha");

      // Wait a tick for the SIGTERM to propagate.
      await new Promise((r) => setTimeout(r, 100));
      expect(mgr.activeSessionCount()).toBe(0);
    });

    it("is a no-op when the agent id is unknown", () => {
      expect(() => mgr.removeAgent("ghost")).not.toThrow();
    });

    it("leaves OTHER agents' sessions untouched", async () => {
      mgr.addAgent(fakeAgent("alpha"));
      mgr.addAgent(fakeAgent("beta"));
      await mgr.prompt("alpha", "u-alpha-1", "hi");
      await mgr.prompt("beta", "u-beta-1", "hi");
      expect(mgr.activeSessionCount()).toBe(2);

      mgr.removeAgent("alpha");
      await new Promise((r) => setTimeout(r, 100));

      expect(mgr.activeSessionCount()).toBe(1);
      // beta still works
      const result = await mgr.prompt("beta", "u-beta-1", "still here?");
      expect(result.stopReason).toBeDefined();
    });
  });

  describe("killAgentSessions", () => {
    it("kills sessions for one agent without removing the agent from the config", async () => {
      mgr.addAgent(fakeAgent("alpha"));
      await mgr.prompt("alpha", "u-alpha-1", "hi");
      expect(mgr.activeSessionCount()).toBe(1);

      mgr.killAgentSessions("alpha");
      await new Promise((r) => setTimeout(r, 100));

      expect(mgr.activeSessionCount()).toBe(0);
      // the agent itself is still registered + addressable
      expect(config.agents.find((a) => a.id === "alpha")).toBeTruthy();
      const result = await mgr.prompt("alpha", "u-alpha-1", "hi again");
      expect(result.stopReason).toBeDefined();
    });

    it("leaves OTHER agents' sessions untouched", async () => {
      mgr.addAgent(fakeAgent("alpha"));
      mgr.addAgent(fakeAgent("beta"));
      await mgr.prompt("alpha", "u-alpha-1", "hi");
      await mgr.prompt("beta", "u-beta-1", "hi");

      mgr.killAgentSessions("alpha");
      await new Promise((r) => setTimeout(r, 100));

      // alpha gone, beta still alive
      expect(mgr.activeSessionCount()).toBe(1);
    });

    it("is a no-op when no sessions exist for that agent", () => {
      mgr.addAgent(fakeAgent("alpha"));
      expect(() => mgr.killAgentSessions("alpha")).not.toThrow();
      expect(() => mgr.killAgentSessions("ghost")).not.toThrow();
    });
  });

  describe("updateAllowlist", () => {
    it("swaps the allowed_users on the shared config + on agentsById", () => {
      mgr.addAgent(fakeAgent("alpha", { allowed_users: ["u-1"] }));

      mgr.updateAllowlist("alpha", ["u-1", "u-2", "u-3"]);

      const onShared = config.agents.find((a) => a.id === "alpha")!;
      expect(onShared.allowed_users).toEqual(["u-1", "u-2", "u-3"]);
      // and isAllowed (which reads from the shared config) sees it
      expect(isAllowed(config, "alpha", "u-3")).toBe(true);
    });

    it("does NOT kill existing sessions (allowlist is enforced at adapter level, not in flight)", async () => {
      mgr.addAgent(fakeAgent("alpha", { allowed_users: ["u-1"] }));
      await mgr.prompt("alpha", "u-1", "hi");
      expect(mgr.activeSessionCount()).toBe(1);

      mgr.updateAllowlist("alpha", ["u-1", "u-2"]);

      // session still alive — no SIGTERM, no respawn
      expect(mgr.activeSessionCount()).toBe(1);
    });

    it("throws when the agent id is unknown", () => {
      expect(() => mgr.updateAllowlist("ghost", ["u-1"])).toThrow(/unknown agent/i);
    });
  });
});

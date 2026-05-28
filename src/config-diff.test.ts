import { describe, expect, it } from "vitest";
import type { AgentConfig, BridgeConfig } from "./config.js";
import { diffConfigs } from "./config-diff.js";

const baseAgent = (id: string, overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  id,
  bot_token: `tok-${id}`,
  allowed_users: [`u-${id}-1`],
  cwd: "/home/agent/cerase/workspace",
  spawn: { command: "docker", args: ["exec", "-i", `cerase-agent-${id}`, "opencode", "acp"] },
  ...overrides,
});

const cfg = (agents: AgentConfig[]): BridgeConfig => ({
  agents,
  session: { idle_timeout_minutes: 60, max_concurrent: 16 },
});

describe("diffConfigs", () => {
  it("identifies an added agent (present in next, missing in prev)", () => {
    const prev = cfg([baseAgent("a")]);
    const next = cfg([baseAgent("a"), baseAgent("b")]);
    const d = diffConfigs(prev, next);
    expect(d.added.map((a) => a.id)).toEqual(["b"]);
    expect(d.removed).toEqual([]);
    expect(d.modified).toEqual([]);
  });

  it("identifies a removed agent (present in prev, missing in next)", () => {
    const prev = cfg([baseAgent("a"), baseAgent("b")]);
    const next = cfg([baseAgent("a")]);
    const d = diffConfigs(prev, next);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual(["b"]);
    expect(d.modified).toEqual([]);
  });

  it("emits zero changes when configs are identical", () => {
    const c = cfg([baseAgent("a"), baseAgent("b")]);
    const d = diffConfigs(c, c);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.modified).toEqual([]);
  });

  it("classifies an allowed_users-only mutation as `allowed_users_only`", () => {
    const prev = cfg([baseAgent("a", { allowed_users: ["u-1"] })]);
    const next = cfg([baseAgent("a", { allowed_users: ["u-1", "u-2"] })]);
    const d = diffConfigs(prev, next);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.modified).toHaveLength(1);
    expect(d.modified[0]!.agentId).toBe("a");
    expect(d.modified[0]!.classification).toBe("allowed_users_only");
  });

  it("classifies a bot_token rotation as `bot_token_or_spawn`", () => {
    const prev = cfg([baseAgent("a", { bot_token: "old" })]);
    const next = cfg([baseAgent("a", { bot_token: "new" })]);
    const d = diffConfigs(prev, next);
    expect(d.modified).toHaveLength(1);
    expect(d.modified[0]!.classification).toBe("bot_token_or_spawn");
  });

  it("classifies a spawn command change as `bot_token_or_spawn`", () => {
    const prev = cfg([baseAgent("a")]);
    const next = cfg([
      baseAgent("a", { spawn: { command: "docker", args: ["exec", "-i", "cerase-agent-OTHER", "opencode", "acp"] } }),
    ]);
    const d = diffConfigs(prev, next);
    expect(d.modified).toHaveLength(1);
    expect(d.modified[0]!.classification).toBe("bot_token_or_spawn");
  });

  it("classifies a cwd change as `bot_token_or_spawn` (respawn-required)", () => {
    const prev = cfg([baseAgent("a", { cwd: "/old" })]);
    const next = cfg([baseAgent("a", { cwd: "/new" })]);
    const d = diffConfigs(prev, next);
    expect(d.modified).toHaveLength(1);
    expect(d.modified[0]!.classification).toBe("bot_token_or_spawn");
  });

  it("classifies a mixed mutation (allowed_users + bot_token) as `mixed`", () => {
    const prev = cfg([baseAgent("a", { bot_token: "old", allowed_users: ["u-1"] })]);
    const next = cfg([baseAgent("a", { bot_token: "new", allowed_users: ["u-1", "u-2"] })]);
    const d = diffConfigs(prev, next);
    expect(d.modified).toHaveLength(1);
    expect(d.modified[0]!.classification).toBe("mixed");
  });

  it("processes multiple agents independently in one diff pass", () => {
    const prev = cfg([
      baseAgent("a"),
      baseAgent("b", { allowed_users: ["x"] }),
      baseAgent("c", { bot_token: "old" }),
    ]);
    const next = cfg([
      baseAgent("a"),                                       // unchanged
      baseAgent("b", { allowed_users: ["x", "y"] }),        // allowed_users_only
      baseAgent("c", { bot_token: "new" }),                 // bot_token_or_spawn
      baseAgent("d"),                                       // added
    ]);
    const d = diffConfigs(prev, next);
    expect(d.added.map((a) => a.id)).toEqual(["d"]);
    expect(d.removed).toEqual([]);
    expect(d.modified).toHaveLength(2);
    const bMod = d.modified.find((m) => m.agentId === "b");
    const cMod = d.modified.find((m) => m.agentId === "c");
    expect(bMod!.classification).toBe("allowed_users_only");
    expect(cMod!.classification).toBe("bot_token_or_spawn");
  });

  it("treats allowed_users as a SET, not a sequence (re-order != mutation)", () => {
    const prev = cfg([baseAgent("a", { allowed_users: ["u-1", "u-2", "u-3"] })]);
    const next = cfg([baseAgent("a", { allowed_users: ["u-3", "u-1", "u-2"] })]);
    const d = diffConfigs(prev, next);
    expect(d.modified).toEqual([]);
  });

  it("treats spawn.args as a sequence (order matters — different argv = respawn)", () => {
    const prev = cfg([baseAgent("a", { spawn: { command: "docker", args: ["a", "b"] } })]);
    const next = cfg([baseAgent("a", { spawn: { command: "docker", args: ["b", "a"] } })]);
    const d = diffConfigs(prev, next);
    expect(d.modified).toHaveLength(1);
    expect(d.modified[0]!.classification).toBe("bot_token_or_spawn");
  });

  it("works on empty configs (zero → zero)", () => {
    const c = cfg([]);
    const d = diffConfigs(c, c);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.modified).toEqual([]);
  });

  it("works going from zero agents to many (cold boot delta)", () => {
    const prev = cfg([]);
    const next = cfg([baseAgent("a"), baseAgent("b")]);
    const d = diffConfigs(prev, next);
    expect(d.added.map((a) => a.id).sort()).toEqual(["a", "b"]);
    expect(d.removed).toEqual([]);
    expect(d.modified).toEqual([]);
  });
});

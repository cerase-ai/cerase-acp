import { describe, expect, it } from "vitest";
import type { AgentConfig, BridgeConfig } from "./config.js";
import { diffConfigs } from "./config-diff.js";

const baseAgent = (id: string, overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  id,
  channel: "discord",
  bot_token: `tok-${id}`,
  allowed_users: [`u-${id}-1`],
  cwd: "/home/agent/cerase/workspace",
  mode: "cerase",
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

  // The mode is chosen once, at the handshake. A live session goes on running
  // under the agent it was created with, so a changed mode that did not
  // respawn would take effect whenever that session happened to end — which is
  // a change arriving at a moment nobody chose.
  it("classifies a mode change as `bot_token_or_spawn` (respawn-required)", () => {
    const prev = cfg([baseAgent("a", { mode: "cerase" })]);
    const next = cfg([baseAgent("a", { mode: "probe" })]);
    const d = diffConfigs(prev, next);
    expect(d.modified).toHaveLength(1);
    expect(d.modified[0]!.classification).toBe("bot_token_or_spawn");
  });

  // A live session keeps the model it had; only a resumed one is set to the
  // configured model. Ending the sessions is what makes a changed model reach
  // the next message, including the reload that first adds the key.
  it("classifies a model change as `bot_token_or_spawn` (respawn-required)", () => {
    const prev = cfg([baseAgent("a")]);
    const next = cfg([baseAgent("a", { model: "cerase-litellm/core" })]);
    const d = diffConfigs(prev, next);
    expect(d.modified).toHaveLength(1);
    expect(d.modified[0]!.classification).toBe("bot_token_or_spawn");
    const changed = diffConfigs(next, cfg([baseAgent("a", { model: "cerase-litellm/pro" })]));
    expect(changed.modified[0]!.classification).toBe("bot_token_or_spawn");
  });

  it("classifies a mixed mutation (allowed_users + bot_token) as `mixed`", () => {
    const prev = cfg([baseAgent("a", { bot_token: "old", allowed_users: ["u-1"] })]);
    const next = cfg([baseAgent("a", { bot_token: "new", allowed_users: ["u-1", "u-2"] })]);
    const d = diffConfigs(prev, next);
    expect(d.modified).toHaveLength(1);
    expect(d.modified[0]!.classification).toBe("mixed");
  });

  it("processes multiple agents independently in one diff pass", () => {
    const prev = cfg([baseAgent("a"), baseAgent("b", { allowed_users: ["x"] }), baseAgent("c", { bot_token: "old" })]);
    const next = cfg([
      baseAgent("a"), // unchanged
      baseAgent("b", { allowed_users: ["x", "y"] }), // allowed_users_only
      baseAgent("c", { bot_token: "new" }), // bot_token_or_spawn
      baseAgent("d"), // added
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

  // The key and project number are the assistant's own Chat app. An adapter
  // holds them from start(), so a change that did not respawn would leave it
  // verifying against the old project and posting with the old key until
  // something else restarted it.
  it("classifies a change to an assistant's workspace_chat block as `bot_token_or_spawn`", () => {
    const app: NonNullable<AgentConfig["workspace_chat"]> = {
      project_number: "111111111111",
      credentials_path: "/var/cerase/workspace-chat-creds/a-1a2b3c4d.json",
    };
    const wc = (overrides: Partial<typeof app>) =>
      baseAgent("a", { channel: "workspace_chat", workspace_chat: { ...app, ...overrides } });
    for (const change of [
      { project_number: "222222222222" },
      { credentials_path: "/var/cerase/workspace-chat-creds/a-5e6f7a8b.json" },
      { certificates_url: "http://fake-google:8080/certs" },
      { api_root: "http://fake-google:8080" },
    ]) {
      const d = diffConfigs(cfg([wc({})]), cfg([wc(change)]));
      expect(d.modified).toEqual([{ agentId: "a", classification: "bot_token_or_spawn" }]);
    }
    expect(diffConfigs(cfg([wc({})]), cfg([wc({})])).modified).toEqual([]);
  });

  // An adapter is made for one channel, from that channel's credentials, so a
  // change to either reaches the person only through a new adapter.
  it("classifies a channel change and a slack_app_token rotation as `bot_token_or_spawn`", () => {
    const respawn = [{ agentId: "a", classification: "bot_token_or_spawn" }];
    const slack = baseAgent("a", { channel: "slack", slack_app_token: "xapp-old" });
    expect(diffConfigs(cfg([slack]), cfg([{ ...slack, slack_app_token: "xapp-new" }])).modified).toEqual(respawn);
    expect(diffConfigs(cfg([baseAgent("a")]), cfg([baseAgent("a", { channel: "telegram" })])).modified).toEqual(
      respawn,
    );
  });

  // A field reaches a running bridge only if this diff sees it change. The
  // literal below has to name every field the schema has, so a field added to
  // the schema fails the type check here until it is listed, and then fails
  // this case until the diff sees it.
  it("sees a change to every field an agent has, each changed alone", () => {
    const before: Required<AgentConfig> = {
      id: "a",
      channel: "slack",
      bot_token: "xoxb-1",
      slack_app_token: "xapp-1",
      allowed_users: ["U1"],
      cwd: "/home/agent/cerase/workspace",
      mode: "cerase",
      model: "cerase-litellm/core",
      workspace_chat: { project_number: "111111111111", credentials_path: "/var/cerase/a.json" },
      spawn: { command: "docker", args: ["exec", "-i", "cerase-a", "opencode", "acp"] },
    };
    const after: Omit<Required<AgentConfig>, "id"> = {
      channel: "telegram",
      bot_token: "xoxb-2",
      slack_app_token: "xapp-2",
      allowed_users: ["U2"],
      cwd: "/home/agent/elsewhere",
      mode: "maintainer",
      model: "cerase-litellm/pro",
      workspace_chat: { project_number: "222222222222", credentials_path: "/var/cerase/a.json" },
      spawn: { command: "docker", args: ["exec", "-i", "cerase-b", "opencode", "acp"] },
    };
    for (const field of Object.keys(after) as Array<keyof typeof after>) {
      const d = diffConfigs(cfg([before]), cfg([{ ...before, [field]: after[field] }]));
      expect(d.modified, field).toHaveLength(1);
    }
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

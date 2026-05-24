import { describe, it, expect } from "vitest";
import { isAllowed } from "./allowlist.js";
import type { BridgeConfig } from "./config.js";

const cfg: BridgeConfig = {
  agents: [
    {
      id: "doc-qa",
      bot_token: "discord-token-doc",
      allowed_users: ["111111111111111111", "222222222222222222"],
      spawn: { command: "docker", args: ["exec", "-i", "cerase-agent-doc-qa", "opencode", "acp"] },
    },
    {
      id: "policy-qa",
      bot_token: "discord-token-policy",
      allowed_users: ["333333333333333333"],
      spawn: { command: "docker", args: ["exec", "-i", "cerase-agent-policy-qa", "opencode", "acp"] },
    },
  ],
  session: { idle_timeout_minutes: 60, max_concurrent: 16 },
};

describe("isAllowed", () => {
  it("returns true for a user_id in the agent's allowed_users list", () => {
    expect(isAllowed(cfg, "doc-qa", "111111111111111111")).toBe(true);
    expect(isAllowed(cfg, "doc-qa", "222222222222222222")).toBe(true);
    expect(isAllowed(cfg, "policy-qa", "333333333333333333")).toBe(true);
  });

  it("returns false for a user_id not in the agent's allowed_users list", () => {
    expect(isAllowed(cfg, "doc-qa", "999999999999999999")).toBe(false);
  });

  it("returns false for an allowed user on a DIFFERENT agent (cross-agent isolation)", () => {
    // 333... is allowed on policy-qa but NOT on doc-qa
    expect(isAllowed(cfg, "doc-qa", "333333333333333333")).toBe(false);
    // 111... is allowed on doc-qa but NOT on policy-qa
    expect(isAllowed(cfg, "policy-qa", "111111111111111111")).toBe(false);
  });

  it("throws a clear error when the agent id is not configured", () => {
    expect(() => isAllowed(cfg, "unknown-agent", "111111111111111111")).toThrow(/unknown-agent/);
  });

  it("returns false when an agent has an empty allowed_users list", () => {
    const empty: BridgeConfig = {
      ...cfg,
      agents: [{ ...cfg.agents[0]!, allowed_users: [] }],
    };
    expect(isAllowed(empty, "doc-qa", "111111111111111111")).toBe(false);
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resolveEnvSubstitutions } from "./config.js";

const VALID_YAML = `
agents:
  - id: doc-qa
    bot_token: \${env:DISCORD_BOT_TOKEN_DOC_QA}
    allowed_users:
      - "111111111111111111"
      - "222222222222222222"
    spawn:
      command: docker
      args: [exec, -i, cerase-agent-doc-qa, opencode, acp]
  - id: policy-qa
    bot_token: \${env:DISCORD_BOT_TOKEN_POLICY_QA}
    allowed_users:
      - "333333333333333333"
    spawn:
      command: docker
      args: [exec, -i, cerase-agent-policy-qa, opencode, acp]
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`;

describe("resolveEnvSubstitutions", () => {
  it("replaces ${env:VAR} with process.env values", () => {
    const env = { FOO: "bar", BAZ: "qux" };
    expect(resolveEnvSubstitutions("hello ${env:FOO}", env)).toBe("hello bar");
    expect(resolveEnvSubstitutions("${env:FOO}-${env:BAZ}", env)).toBe("bar-qux");
  });

  it("leaves non-${env:...} text untouched", () => {
    expect(resolveEnvSubstitutions("plain text", {})).toBe("plain text");
    expect(resolveEnvSubstitutions("$DOLLAR not substituted", {})).toBe("$DOLLAR not substituted");
  });

  it("throws a clear error when an ${env:VAR} reference is missing", () => {
    expect(() => resolveEnvSubstitutions("${env:MISSING}", {})).toThrow(/MISSING/);
  });
});

describe("loadConfig", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cerase-acp-test-"));
    path = join(dir, "agents.yaml");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads a valid YAML and returns a typed config", () => {
    writeFileSync(path, VALID_YAML);
    const cfg = loadConfig(path, {
      DISCORD_BOT_TOKEN_DOC_QA: "tok-doc",
      DISCORD_BOT_TOKEN_POLICY_QA: "tok-pol",
    });
    expect(cfg.agents).toHaveLength(2);
    expect(cfg.agents[0]!.id).toBe("doc-qa");
    expect(cfg.agents[0]!.bot_token).toBe("tok-doc");
    expect(cfg.agents[0]!.allowed_users).toEqual(["111111111111111111", "222222222222222222"]);
    expect(cfg.agents[0]!.spawn.command).toBe("docker");
    expect(cfg.agents[0]!.spawn.args).toEqual(["exec", "-i", "cerase-agent-doc-qa", "opencode", "acp"]);
    expect(cfg.session.idle_timeout_minutes).toBe(60);
    expect(cfg.session.max_concurrent).toBe(16);
  });

  it("defaults agent.cwd to /home/agent/cerase/workspace when absent", () => {
    writeFileSync(path, VALID_YAML);
    const cfg = loadConfig(path, {
      DISCORD_BOT_TOKEN_DOC_QA: "tok-doc",
      DISCORD_BOT_TOKEN_POLICY_QA: "tok-pol",
    });
    expect(cfg.agents[0]!.cwd).toBe("/home/agent/cerase/workspace");
    expect(cfg.agents[1]!.cwd).toBe("/home/agent/cerase/workspace");
  });

  it("respects an explicit agent.cwd override", () => {
    writeFileSync(
      path,
      `
agents:
  - id: doc-qa
    bot_token: tok
    allowed_users: []
    cwd: /custom/workspace
    spawn: { command: docker, args: [] }
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`,
    );
    const cfg = loadConfig(path, {});
    expect(cfg.agents[0]!.cwd).toBe("/custom/workspace");
  });

  it("C2-0: accepts channel 'web' with NO credential fields (panel-only agent)", () => {
    writeFileSync(
      path,
      `
agents:
  - id: maintainer-1
    channel: web
    allowed_users: ["maintainer:org-123"]
    spawn: { command: docker, args: [exec, -i, cerase-agent-9, opencode, acp] }
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`,
    );
    const cfg = loadConfig(path, {});
    expect(cfg.agents[0]!.channel).toBe("web");
    expect(cfg.agents[0]!.allowed_users).toEqual(["maintainer:org-123"]);
  });

  it("throws a clear error when the config file does not exist", () => {
    expect(() => loadConfig("/nonexistent/path/agents.yaml", {})).toThrow(/agents\.yaml/);
  });

  it("throws a clear error when the YAML is malformed", () => {
    writeFileSync(path, "agents: [\n  - id: broken");
    expect(() => loadConfig(path, {})).toThrow();
  });

  it("throws when a required ${env:...} token is missing from process.env", () => {
    writeFileSync(path, VALID_YAML);
    // DISCORD_BOT_TOKEN_POLICY_QA intentionally absent
    expect(() => loadConfig(path, { DISCORD_BOT_TOKEN_DOC_QA: "tok-doc" })).toThrow(/DISCORD_BOT_TOKEN_POLICY_QA/);
  });

  it("accepts an empty agents array (zero-Agent boot is valid since v0.2)", () => {
    writeFileSync(
      path,
      `
agents: []
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`,
    );
    const cfg = loadConfig(path, {});
    expect(cfg.agents).toEqual([]);
  });

  it("throws when the schema is violated (missing required field)", () => {
    writeFileSync(
      path,
      `
agents:
  - id: doc-qa
    # bot_token intentionally missing
    allowed_users: []
    spawn: { command: docker, args: [] }
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`,
    );
    expect(() => loadConfig(path, {})).toThrow();
  });

  it("throws when an agent id contains characters incompatible with shell/docker names", () => {
    writeFileSync(
      path,
      `
agents:
  - id: "doc qa with spaces"
    bot_token: tok
    allowed_users: []
    spawn: { command: docker, args: [] }
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`,
    );
    expect(() => loadConfig(path, {})).toThrow();
  });

  it("throws when agent ids collide", () => {
    writeFileSync(
      path,
      `
agents:
  - id: doc-qa
    bot_token: tok1
    allowed_users: []
    spawn: { command: docker, args: [] }
  - id: doc-qa
    bot_token: tok2
    allowed_users: []
    spawn: { command: docker, args: [] }
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`,
    );
    expect(() => loadConfig(path, {})).toThrow(/duplicate|unique/i);
  });

  // CHANNEL-1 schema cases (OPT-21 D3). Verifies the per-channel
  // superRefine matrix in config.ts: discord/telegram need bot_token,
  // slack additionally needs slack_app_token, workspace_chat needs
  // workspace_chat_credentials_path. Legacy YAMLs without `channel`
  // default to 'discord' for back-compat.

  it("CHANNEL-1: legacy YAML without `channel` defaults to discord", () => {
    writeFileSync(
      path,
      `
agents:
  - id: doc-qa
    bot_token: tok
    allowed_users: []
    spawn: { command: docker, args: [] }
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`,
    );
    const cfg = loadConfig(path, {});
    expect(cfg.agents[0]!.channel).toBe("discord");
  });

  it("CHANNEL-1: channel=telegram + bot_token is valid", () => {
    writeFileSync(
      path,
      `
agents:
  - id: tg-agent
    channel: telegram
    bot_token: TG_TOKEN
    allowed_users: ["123456789"]
    spawn: { command: docker, args: [] }
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`,
    );
    const cfg = loadConfig(path, {});
    expect(cfg.agents[0]!.channel).toBe("telegram");
    expect(cfg.agents[0]!.bot_token).toBe("TG_TOKEN");
  });

  it("CHANNEL-1: channel=slack rejected without slack_app_token", () => {
    writeFileSync(
      path,
      `
agents:
  - id: sl-agent
    channel: slack
    bot_token: xoxb-foo
    allowed_users: ["U_ABCDEF"]
    spawn: { command: docker, args: [] }
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`,
    );
    expect(() => loadConfig(path, {})).toThrow(/slack_app_token/i);
  });

  it("CHANNEL-1: channel=workspace_chat + workspace_chat_credentials_path is valid", () => {
    writeFileSync(
      path,
      `
agents:
  - id: wc-agent
    channel: workspace_chat
    workspace_chat_credentials_path: /var/cerase/workspace-chat-creds/wc-agent.json
    allowed_users: ["ops@guidance.studio"]
    spawn: { command: docker, args: [] }
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`,
    );
    const cfg = loadConfig(path, {});
    expect(cfg.agents[0]!.channel).toBe("workspace_chat");
    expect(cfg.agents[0]!.workspace_chat_credentials_path).toBe("/var/cerase/workspace-chat-creds/wc-agent.json");
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resolveEnvSubstitutions } from "./config.js";
import { CERASE_SESSION_MODE } from "./session-mode.js";

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

  // The mode IS the agent selector: opencode exposes its primary agents as ACP
  // session modes and `opencode acp` has no flag to pick one. It was a constant
  // until the health probe needed an assistant that answers one word.
  it("defaults agent.mode to the Cerase profile when absent", () => {
    writeFileSync(path, VALID_YAML);
    const cfg = loadConfig(path, {
      DISCORD_BOT_TOKEN_DOC_QA: "tok-doc",
      DISCORD_BOT_TOKEN_POLICY_QA: "tok-pol",
    });
    // A config written before the field existed has to go on asking for the
    // mode it always asked for, or every appliance loses its assistant on the
    // deploy that adds the field.
    expect(cfg.agents[0]!.mode).toBe(CERASE_SESSION_MODE);
    expect(cfg.agents[1]!.mode).toBe(CERASE_SESSION_MODE);
  });

  it("respects an explicit agent.mode override", () => {
    writeFileSync(
      path,
      `
agents:
  - id: doc-qa
    bot_token: tok
    allowed_users: []
    mode: probe
    spawn: { command: docker, args: [] }
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`,
    );
    const cfg = loadConfig(path, {});
    expect(cfg.agents[0]!.mode).toBe("probe");
  });

  // The model a resumed session is set back to. Written by the control-plane,
  // and optional: a file from before the key existed must go on loading, and
  // it then leaves a resumed session on the model opencode restored.
  it("leaves agent.model unset when absent", () => {
    writeFileSync(path, VALID_YAML);
    const cfg = loadConfig(path, {
      DISCORD_BOT_TOKEN_DOC_QA: "tok-doc",
      DISCORD_BOT_TOKEN_POLICY_QA: "tok-pol",
    });
    expect(cfg.agents[0]!.model).toBeUndefined();
    expect(cfg.agents[1]!.model).toBeUndefined();
  });

  it("parses agent.model as the provider/model pair it names", () => {
    writeFileSync(
      path,
      `
agents:
  - id: doc-qa
    bot_token: tok
    allowed_users: []
    model: cerase-litellm/core
    spawn: { command: docker, args: [] }
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`,
    );
    const cfg = loadConfig(path, {});
    expect(cfg.agents[0]!.model).toBe("cerase-litellm/core");
  });

  it("rejects an empty agent.model rather than setting a session to nothing", () => {
    writeFileSync(
      path,
      `
agents:
  - id: doc-qa
    bot_token: tok
    allowed_users: []
    model: ""
    spawn: { command: docker, args: [] }
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`,
    );
    expect(() => loadConfig(path, {})).toThrow(/agents\.0\.model/);
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

  // Channel schema cases. Verifies the per-channel
  // superRefine matrix in config.ts: discord/telegram need bot_token,
  // slack additionally needs slack_app_token; workspace_chat's own app is checked when it starts
  // per agent. Legacy YAMLs without `channel` default to 'discord' for
  // back-compat.

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

  // Every assistant is its own Chat app (DEC-37 in cerase-core), so its key and
  // project number are written on the assistant, like a Discord token. A block on
  // one assistant reaches that assistant and no other.
  it("an assistant's workspace_chat block loads on that assistant only", () => {
    writeFileSync(
      path,
      `
agents:
  - id: agent-1
    channel: workspace_chat
    allowed_users: ["mario.rossi@example.com"]
    workspace_chat:
      project_number: "123456789012"
      credentials_path: /var/cerase/workspace-chat-creds/agent-1.json
    spawn: { command: docker, args: [] }
  - id: agent-2
    channel: workspace_chat
    allowed_users: ["anna.bianchi@example.com"]
    workspace_chat:
      project_number: "210987654321"
      credentials_path: /var/cerase/workspace-chat-creds/agent-2.json
    spawn: { command: docker, args: [] }
  - id: maintainer-1
    channel: web
    allowed_users: ["maintainer:org-1"]
    spawn: { command: docker, args: [] }
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`,
    );
    const cfg = loadConfig(path, {});
    expect(cfg.agents.map((a) => [a.id, a.workspace_chat])).toEqual([
      [
        "agent-1",
        { project_number: "123456789012", credentials_path: "/var/cerase/workspace-chat-creds/agent-1.json" },
      ],
      [
        "agent-2",
        { project_number: "210987654321", credentials_path: "/var/cerase/workspace-chat-creds/agent-2.json" },
      ],
      ["maintainer-1", undefined],
    ]);
  });

  // Where the bridge reaches Google can be written in the block, so a test can
  // serve those endpoints itself. The load keeps what is written, a malformed
  // address included: the assistant refuses it when it starts, and the other
  // channels in the file keep running.
  it("the addresses of Google's endpoints in an assistant's block load as written", () => {
    writeFileSync(
      path,
      `
agents:
  - id: agent-1
    channel: workspace_chat
    allowed_users: ["mario.rossi@example.com"]
    workspace_chat:
      project_number: "123456789012"
      credentials_path: /var/cerase/workspace-chat-creds/agent-1.json
      certificates_url: http://fake-google:8080/certs
      api_root: htps://chat.googleapis.com
    spawn: { command: docker, args: [] }
  - id: doc-qa
    channel: discord
    bot_token: tok-doc
    allowed_users: ["111"]
    spawn: { command: docker, args: [] }
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`,
    );
    const cfg = loadConfig(path, {});
    expect(cfg.agents.map((a) => [a.id, a.workspace_chat?.certificates_url, a.workspace_chat?.api_root])).toEqual([
      ["agent-1", "http://fake-google:8080/certs", "htps://chat.googleapis.com"],
      ["doc-qa", undefined, undefined],
    ]);
  });

  // Symfony's dumper quotes a numeric string, but a renderer that casts the
  // column to an integer writes a bare number. Both mean the same project.
  it("a project number written as a YAML integer loads as the same string", () => {
    writeFileSync(
      path,
      `
agents:
  - id: agent-1
    channel: workspace_chat
    allowed_users: ["mario.rossi@example.com"]
    workspace_chat:
      project_number: 123456789012
      credentials_path: /var/cerase/workspace-chat-creds/agent-1.json
    spawn: { command: docker, args: [] }
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`,
    );
    expect(loadConfig(path, {}).agents[0]!.workspace_chat?.project_number).toBe("123456789012");
  });

  // A missing block is the adapter's to refuse, not the loader's: failing the
  // whole file would take the panel-only maintainer down with the channel.
  it("a workspace_chat agent without its block still loads", () => {
    writeFileSync(
      path,
      `
agents:
  - id: agent-1
    channel: workspace_chat
    allowed_users: ["mario.rossi@example.com"]
    spawn: { command: docker, args: [] }
  - id: maintainer-1
    channel: web
    allowed_users: ["maintainer:org-1"]
    spawn: { command: docker, args: [] }
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`,
    );
    const cfg = loadConfig(path, {});
    expect(cfg.agents.map((a) => [a.id, a.workspace_chat])).toEqual([
      ["agent-1", undefined],
      ["maintainer-1", undefined],
    ]);
    expect(Object.keys(cfg)).toEqual(["agents", "session"]);
  });

  // The organisation's one app is gone. A file written before the change still
  // loads, and its top-level block and domains reach nobody: an assistant is
  // reached through its own app or not at all.
  it("the organisation-wide block and its domains from the old design are dropped on load", () => {
    writeFileSync(
      path,
      `
workspace_chat:
  project_number: "123456789012"
  credentials_path: /var/cerase/workspace-chat-creds/service-account.json
  allowed_domains: [example.com]
agents:
  - id: agent-1
    channel: workspace_chat
    allowed_users: ["mario.rossi@example.com"]
    workspace_chat:
      project_number: "210987654321"
      credentials_path: /var/cerase/workspace-chat-creds/agent-1.json
      allowed_domains: [example.com]
    spawn: { command: docker, args: [] }
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`,
    );
    const cfg = loadConfig(path, {});
    expect(Object.keys(cfg)).toEqual(["agents", "session"]);
    expect(cfg.agents[0]!.workspace_chat).toEqual({
      project_number: "210987654321",
      credentials_path: "/var/cerase/workspace-chat-creds/agent-1.json",
    });
  });

  // The per-assistant fields belong to the design where every assistant was
  // its own Chat app. A file still carrying them loads, and they are dropped:
  // nothing reads them, so a value left there cannot look like configuration.
  it("per-assistant key and audience fields from the old design are dropped on load", () => {
    writeFileSync(
      path,
      `
agents:
  - id: agent-1
    channel: workspace_chat
    workspace_chat_credentials_path: /var/cerase/workspace-chat-creds/agent-1.json
    workspace_chat_verification_audience: "123456789012"
    allowed_users: ["mario.rossi@example.com"]
    spawn: { command: docker, args: [] }
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`,
    );
    const agent = loadConfig(path, {}).agents[0]! as Record<string, unknown>;
    expect(Object.keys(agent).filter((k) => k.startsWith("workspace_chat"))).toEqual([]);
  });
});

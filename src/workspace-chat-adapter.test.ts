// What the Workspace Chat adapter needs before it opens the webhook, and what
// it says when something is missing.
//
// The listener verifies every event against the organisation's project number
// and answers with the organisation's key, so it refuses to come up without
// either, and names what is missing: a channel that stays down for a reason no
// screen shows is the failure this adapter has already had. Discord, Slack,
// Telegram and web adapters are unaffected by any of it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeServiceAccount, writeKeyFile } from "./__tests__/fake-google.js";
import type { ChatAdapter } from "./chat-adapter.js";
import { createChatAdapter } from "./chat-adapter.js";
import type { AgentConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";
import { workspaceChatListenerPort } from "./workspace-chat-adapter.js";

process.env.WORKSPACE_CHAT_PORT = "0";

const DISPATCHER = {} as unknown as Dispatcher;

describe("workspace-chat adapter: what start() requires", () => {
  let dir: string;
  let keyPath: string;
  let adapter: ChatAdapter | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wc-start-"));
    keyPath = join(dir, "service-account.json");
    writeKeyFile(keyPath, makeServiceAccount(), "https://oauth2.googleapis.com/token");
  });

  afterEach(async () => {
    await adapter?.stop();
    adapter = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function wcAgent(app: AgentConfig["workspace_chat"]): AgentConfig {
    return {
      id: "agent-1",
      channel: "workspace_chat",
      allowed_users: ["mario.rossi@example.com"],
      cwd: "/home/agent/cerase/workspace",
      mode: "cerase",
      spawn: { command: "docker", args: [] },
      ...(app ? { workspace_chat: app } : {}),
    };
  }

  it("refuses without the organisation's Chat app, naming every setting it lacks", async () => {
    adapter = await createChatAdapter(wcAgent(undefined), DISPATCHER);
    await expect(adapter.start()).rejects.toThrow(
      "agent \"agent-1\" channel='workspace_chat' refuses to start: workspace_chat.project_number, workspace_chat.credentials_path, workspace_chat.allowed_domains missing from agents.yaml",
    );
    expect(workspaceChatListenerPort()).toBeUndefined();
  });

  it("refuses a project number that is not one, and a domain that is an address", async () => {
    adapter = await createChatAdapter(
      wcAgent({ project_number: "tenant-project", credentials_path: keyPath, allowed_domains: ["@example.com"] }),
      DISPATCHER,
    );
    await expect(adapter.start()).rejects.toThrow(
      "agent \"agent-1\" channel='workspace_chat' refuses to start: workspace_chat.project_number must be the Google Cloud project number (digits only); workspace_chat.allowed_domains has an entry that is not a domain: @example.com",
    );
    expect(workspaceChatListenerPort()).toBeUndefined();
  });

  it("refuses a certificates_url or api_root the endpoint rule refuses, naming each key and its value", async () => {
    adapter = await createChatAdapter(
      wcAgent({
        project_number: "123456789012",
        credentials_path: keyPath,
        allowed_domains: ["example.com"],
        certificates_url: "http://www.googleapis.com/service_accounts/v1/metadata/x509/chat",
        api_root: "chat.googleapis.com",
      }),
      DISPATCHER,
    );
    await expect(adapter.start()).rejects.toThrow(
      'agent "agent-1" channel=\'workspace_chat\' refuses to start: workspace_chat.certificates_url must be an https URL, or an http URL to a host name without a dot or to a loopback address, and "http://www.googleapis.com/service_accounts/v1/metadata/x509/chat" is neither; workspace_chat.api_root must be an https URL, or an http URL to a host name without a dot or to a loopback address, and "chat.googleapis.com" is neither',
    );
    expect(workspaceChatListenerPort()).toBeUndefined();
  });

  it("refuses when the key cannot be read, naming the path and the reason", async () => {
    const absent = join(dir, "absent.json");
    adapter = await createChatAdapter(
      wcAgent({ project_number: "123456789012", credentials_path: absent, allowed_domains: ["example.com"] }),
      DISPATCHER,
    );
    await expect(adapter.start()).rejects.toThrow(
      `the Workspace Chat service-account key at ${absent} cannot be read (ENOENT)`,
    );
    expect(workspaceChatListenerPort()).toBeUndefined();
  });

  it("refuses a key whose token_uri would send the signed assertion in plaintext, naming the path and the field", async () => {
    writeKeyFile(keyPath, makeServiceAccount(), "http://oauth2.googleapis.com/token");
    adapter = await createChatAdapter(
      wcAgent({ project_number: "123456789012", credentials_path: keyPath, allowed_domains: ["example.com"] }),
      DISPATCHER,
    );
    const err = await adapter.start().catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      `the Workspace Chat service-account key at ${keyPath} is refused: token_uri must be an https URL, or an http URL to a host name without a dot or to a loopback address`,
    );
    expect(workspaceChatListenerPort()).toBeUndefined();
  });

  it("opens the webhook with a complete app and a readable key, and closes it with the last adapter", async () => {
    adapter = await createChatAdapter(
      wcAgent({ project_number: "123456789012", credentials_path: keyPath, allowed_domains: ["example.com"] }),
      DISPATCHER,
    );
    await adapter.start();
    expect(workspaceChatListenerPort()).toBeGreaterThan(0);
    await adapter.stop();
    adapter = undefined;
    expect(workspaceChatListenerPort()).toBeUndefined();
  });

  it("other channels start normally without any Workspace Chat configuration", async () => {
    const web = await createChatAdapter(
      {
        id: "maintainer-1",
        channel: "web",
        allowed_users: ["maintainer:org-123"],
        cwd: "/home/agent/cerase/workspace",
        mode: "cerase",
        spawn: { command: "docker", args: [] },
      },
      DISPATCHER,
    );
    await expect(web.start()).resolves.toBeUndefined();
    await web.stop();

    const discord = await createChatAdapter(
      {
        id: "doc-qa",
        channel: "discord",
        bot_token: "tok-doc",
        allowed_users: ["111"],
        cwd: "/home/agent/cerase/workspace",
        mode: "cerase",
        spawn: { command: "docker", args: [] },
      },
      DISPATCHER,
    );
    expect(discord.agentId).toBe("doc-qa");
  });
});

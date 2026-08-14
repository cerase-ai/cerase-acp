// Fail-closed caller-identity gate on the Workspace Chat webhook listener.
//
// The adapter's HTTP listener derives the message sender from the request
// BODY (`event.user.email`): anyone who can reach the port could impersonate
// any allowed user. Until Google-signed request verification ships (a future
// milestone), the adapter must REFUSE to start unless the operator has
// explicitly configured the verification audience — so this listener can
// never be enabled by accident without caller verification in place.
// Discord / Slack / Telegram / web adapters are unaffected.

// The shared HTTP listener's port is read at module load
// (WORKSPACE_CHAT_PORT). Set it to 0 (ephemeral) BEFORE the adapter module
// is (dynamically) imported so the positive-path test never binds :7475.
process.env.WORKSPACE_CHAT_PORT = "0";

import { afterEach, describe, expect, it } from "vitest";
import type { ChatAdapter } from "./chat-adapter.js";
import { createChatAdapter } from "./chat-adapter.js";
import type { AgentConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";

const DISPATCHER = {} as unknown as Dispatcher;

function wcAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "wc-agent",
    channel: "workspace_chat",
    workspace_chat_credentials_path: "/var/cerase/workspace-chat-creds/wc-agent.json",
    allowed_users: ["ops@guidance.studio"],
    cwd: "/home/agent/cerase/workspace",
    spawn: { command: "docker", args: [] },
    ...overrides,
  } as AgentConfig;
}

describe("workspace-chat adapter fail-closed startup guard (M-ACP-WSCHAT-GUARD-1)", () => {
  let adapter: ChatAdapter | undefined;

  afterEach(async () => {
    // Defensive: if a test unexpectedly started the shared listener, close
    // it so it never leaks into the next test.
    if (adapter) {
      await adapter.stop().catch(() => undefined);
      adapter = undefined;
    }
  });

  it("start() throws a descriptive error naming the missing verification config", async () => {
    adapter = await createChatAdapter(wcAgent(), DISPATCHER);
    // Fail closed: without workspace_chat_verification_audience the webhook
    // listener must never come up — the error names the missing knob so the
    // operator knows exactly what to configure.
    await expect(adapter.start()).rejects.toThrow(/workspace_chat_verification_audience/);
    await expect(adapter.start()).rejects.toThrow(/caller-identity verification/i);
  });

  it("start() proceeds past the guard when the verification audience is configured", async () => {
    adapter = await createChatAdapter(wcAgent({ workspace_chat_verification_audience: "123456789012" }), DISPATCHER);
    // With the audience configured the guard lets the adapter start (the
    // listener binds an ephemeral port — WORKSPACE_CHAT_PORT=0 above).
    await expect(adapter.start()).resolves.toBeUndefined();
    await adapter.stop();
    adapter = undefined;
  });

  it("other channels start normally without any workspace-chat verification config", async () => {
    // web: a real start()-able channel with no external transport — must be
    // completely unaffected by the workspace_chat guard.
    const web = await createChatAdapter(
      {
        id: "maintainer-1",
        channel: "web",
        allowed_users: ["maintainer:org-123"],
        cwd: "/home/agent/cerase/workspace",
        spawn: { command: "docker", args: [] },
      } as unknown as AgentConfig,
      DISPATCHER,
    );
    await expect(web.start()).resolves.toBeUndefined();
    await web.stop();

    // discord: construction must not trip the guard either (start() needs a
    // live gateway + real token, so construction is the right boundary here).
    const discord = await createChatAdapter(
      {
        id: "doc-qa",
        channel: "discord",
        bot_token: "tok-doc",
        allowed_users: ["111"],
        cwd: "/home/agent/cerase/workspace",
        spawn: { command: "docker", args: [] },
      } as unknown as AgentConfig,
      DISPATCHER,
    );
    expect(discord.agentId).toBe("doc-qa");
  });
});

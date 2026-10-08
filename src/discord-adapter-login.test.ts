import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakeDiscord, startFakeDiscord } from "./__tests__/fake-discord.js";
import type { ChatAdapter } from "./chat-adapter.js";
import type { AgentConfig } from "./config.js";
import { createDiscordAdapter } from "./discord-adapter.js";
import type { Dispatcher } from "./dispatcher.js";

const agent: AgentConfig = {
  id: "agent-7",
  channel: "discord",
  cwd: "/home/agent/cerase/workspace",
  mode: "cerase",
  bot_token: "MTAx.token.value",
  allowed_users: ["123456789012345678"],
  spawn: { command: "true", args: [] },
};

// The supervisor retries a failed start() on the same adapter. These drive
// the installed discord.js against a stand-in Discord through a login the
// gateway refuses and the retry that succeeds once the portal switch is
// ticked, and check what the adapter is left with after the retry.
describe("a Discord adapter started again after a failed login", () => {
  let discord: FakeDiscord | undefined;
  let adapter: ChatAdapter | undefined;

  afterEach(async () => {
    await adapter?.stop();
    adapter = undefined;
    await discord?.close();
    discord = undefined;
  });

  async function recoveredAfterARefusal(): Promise<{ discord: FakeDiscord; adapter: ChatAdapter }> {
    const fake = await startFakeDiscord({ identifyCloseCode: 4014 });
    discord = fake;
    const started = createDiscordAdapter(agent, {} as Dispatcher, { rest: { api: fake.api } });
    adapter = started;
    await expect(started.start()).rejects.toThrow("Used disallowed intents");
    fake.identifyCloseCode = null;
    await started.start();
    return { discord: fake, adapter: started };
  }

  it("reports ready once the retry has logged in", async () => {
    const { adapter } = await recoveredAfterARefusal();
    await vi.waitFor(() => expect(adapter.ready?.()).toBe(true));
  });

  it("comes back from a connection Discord drops, and reports ready again", async () => {
    const { discord, adapter } = await recoveredAfterARefusal();
    const before = discord.connections();
    discord.dropConnections(4000);
    await vi.waitFor(() => expect(discord.connections()).toBe(before + 1), { timeout: 5000 });
    await vi.waitFor(() => expect(adapter.ready?.()).toBe(true));
  });

  it("closes the gateway connection the retry opened when it is stopped", async () => {
    const { discord, adapter: started } = await recoveredAfterARefusal();
    expect(discord.openConnections()).toBe(1);
    await started.stop();
    adapter = undefined;
    await vi.waitFor(() => expect(discord.openConnections()).toBe(0));
  });

  it("delivers a reply through the client that logged in, with its token", async () => {
    const { discord, adapter } = await recoveredAfterARefusal();
    const result = await adapter.makeSendTarget("123456789012345678")("ciao");
    expect(result).toEqual({ ok: true });
    const post = discord.requests.find((r) => r.method === "POST" && r.path.endsWith("/messages"));
    expect(post?.authorization).toBe(`Bot ${agent.bot_token}`);
    expect(post?.body).toMatchObject({ content: "ciao" });
  });
});

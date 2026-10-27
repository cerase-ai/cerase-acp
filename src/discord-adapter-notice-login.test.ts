// A Discord client that has not received READY has no bot user, and
// discord.js's DM lookup reads it, so a send in that window meets a TypeError.
// An assistant created a second ago is in that window when the control-plane
// sends its first notices: the adapter waits for the login under way, up to a
// bound, and otherwise answers that the channel is not ready.

import { afterEach, describe, expect, it, vi } from "vitest";
import { FAKE_DM_CHANNEL_ID, type FakeDiscord, startFakeDiscord } from "./__tests__/fake-discord.js";
import type { ChatAdapter, DeliveryResult } from "./chat-adapter.js";
import type { AgentConfig } from "./config.js";
import { createDiscordAdapter } from "./discord-adapter.js";
import type { Dispatcher } from "./dispatcher.js";
import { isNoSharedServer } from "./no-shared-server.js";
import { discordNoticeMessages, type PlatformNotice } from "./platform-notice.js";

const agent: AgentConfig = {
  id: "agent-8",
  channel: "discord",
  cwd: "/home/agent/cerase/workspace",
  mode: "cerase",
  bot_token: "MTAx.token.value",
  allowed_users: ["310000000000000444"],
  spawn: { command: "true", args: [] },
};

const PERSON = "310000000000000444";

const NOTICE: PlatformNotice = {
  title: "Collega il tuo account",
  body: "«Nadia» può usare Gmail quando colleghi il tuo account.",
  link: { url: "https://example.test/c/abc", label: "Collega Gmail" },
};

const messagePosts = (fake: FakeDiscord) =>
  fake.requests.filter((request) => request.method === "POST" && request.path.endsWith("/messages"));

const failureCode = (result: DeliveryResult): unknown =>
  result.ok ? undefined : (result.error as Error & { code?: unknown }).code;

describe("a Discord adapter sending a notice around the login", () => {
  let discord: FakeDiscord | undefined;
  let adapter: ChatAdapter | undefined;

  afterEach(async () => {
    discord?.releaseReady();
    await adapter?.stop();
    adapter = undefined;
    await discord?.close();
    discord = undefined;
  });

  it("a notice sent while the client is still logging in reaches the person once the login completes", async () => {
    const fake = await startFakeDiscord({ holdReady: true });
    discord = fake;
    const started = createDiscordAdapter(agent, {} as Dispatcher, { rest: { api: fake.api } });
    adapter = started;

    const login = started.start();
    await vi.waitFor(() => expect(fake.connections()).toBeGreaterThanOrEqual(1));

    const sending = started.sendNotice!(PERSON, NOTICE);
    // The client is still logging in: let the send reach the DM lookup it makes
    // before READY, then finish the login the adapter has to wait for.
    await new Promise((resolve) => setTimeout(resolve, 50));
    fake.releaseReady();
    const [result] = await Promise.all([sending, login]);

    expect(result).toEqual({
      ok: true,
      ref: { channel: "discord", channelId: FAKE_DM_CHANNEL_ID, messageId: expect.any(String) },
    });
    expect(messagePosts(fake)).toHaveLength(discordNoticeMessages(NOTICE).length);
  });

  it("a notice to a client that does not log in within the wait fails as channel_not_ready", async () => {
    const fake = await startFakeDiscord({ holdReady: true });
    discord = fake;
    const options = { rest: { api: fake.api }, loginWaitMs: 200 };
    const started = createDiscordAdapter(agent, {} as Dispatcher, options);
    adapter = started;

    const login = started.start();
    await vi.waitFor(() => expect(fake.connections()).toBeGreaterThanOrEqual(1));

    const result = await started.sendNotice!(PERSON, NOTICE);

    fake.releaseReady();
    await login;

    expect(result.ok).toBe(false);
    expect(failureCode(result)).toBe("channel_not_ready");
    expect(messagePosts(fake)).toHaveLength(0);
  });

  it("a notice to a client that was never started fails as channel_not_ready at once", async () => {
    const fake = await startFakeDiscord();
    discord = fake;
    const options = { rest: { api: fake.api }, loginWaitMs: 5000 };
    const started = createDiscordAdapter(agent, {} as Dispatcher, options);
    adapter = started;

    const began = Date.now();
    const result = await started.sendNotice!(PERSON, NOTICE);
    const elapsed = Date.now() - began;

    expect(result.ok).toBe(false);
    expect(failureCode(result)).toBe("channel_not_ready");
    expect(elapsed).toBeLessThan(1000);
  });

  it("a notice Discord refuses with 50278 comes back as the refusal the bridge reads as no_shared_server", async () => {
    const fake = await startFakeDiscord({ refusingDmsTo: new Set([PERSON]) });
    discord = fake;
    const started = createDiscordAdapter(agent, {} as Dispatcher, { rest: { api: fake.api } });
    adapter = started;
    await started.start();

    const result = await started.sendNotice!(PERSON, NOTICE);

    expect(result.ok).toBe(false);
    expect(isNoSharedServer(result.ok ? undefined : result.error)).toBe(true);
  });
});

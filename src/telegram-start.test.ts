// The Telegram adapter's start() answers whether the bot connected. telegraf's
// launch() asks Telegram who the bot is before it starts polling, calls its
// onLaunch callback once Telegram has answered, and rejects when Telegram
// refuses the token. The SDK is replaced by a launch() each test scripts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";
import { createTelegramAdapter } from "./telegram-adapter.js";

const sdk = vi.hoisted(() => ({
  launch: (_onLaunch: () => void): Promise<void> => new Promise<void>(() => {}),
  launchArgs: [] as unknown[][],
}));

vi.mock("telegraf", () => {
  class Telegraf {
    telegram = { sendMessage: async () => ({}), sendChatAction: async () => true };
    on() {}
    catch() {}
    launch(...args: unknown[]) {
      sdk.launchArgs.push(args);
      const onLaunch = args.find((a): a is () => void => typeof a === "function");
      return sdk.launch(onLaunch ?? (() => {}));
    }
    stop() {}
  }
  return { Telegraf };
});

const AGENT: AgentConfig = {
  id: "agent-1",
  channel: "telegram",
  bot_token: "123456:not-a-real-token",
  allowed_users: ["42"],
  cwd: "/home/agent/cerase/workspace",
  mode: "cerase",
  spawn: { command: "docker", args: [] },
};

const adapter = () => createTelegramAdapter(AGENT, {} as unknown as Dispatcher);

/** Telegram's answer to getMe with a token it does not know, as telegraf raises it. */
function unauthorized(): Error {
  return Object.assign(new Error("401: Unauthorized"), {
    code: 401,
    response: { ok: false, error_code: 401, description: "Unauthorized" },
  });
}

beforeEach(() => {
  sdk.launchArgs.length = 0;
});

describe("the Telegram adapter's start", () => {
  it("rejects when Telegram refuses the token, so the bridge reports the channel down", async () => {
    sdk.launch = async () => {
      throw unauthorized();
    };
    await expect(adapter().start()).rejects.toThrow("401: Unauthorized");
  });

  it("resolves only once Telegram has answered", async () => {
    let connect = () => {};
    sdk.launch = (onLaunch) => {
      connect = onLaunch;
      return new Promise<void>(() => {});
    };
    let started = false;
    const start = adapter()
      .start()
      .then(() => {
        started = true;
      });
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(false);

    connect();
    await start;
    expect(started).toBe(true);
  });

  it("stays started when polling fails after Telegram answered", async () => {
    sdk.launch = async (onLaunch) => {
      onLaunch();
      throw new Error("409: Conflict: terminated by other getUpdates request");
    };
    await expect(adapter().start()).resolves.toBeUndefined();
  });
});

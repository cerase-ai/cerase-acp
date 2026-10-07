// Each chat adapter that can edit a message keeps a turn's status line as one
// message of its own: posted once, edited in place, deleted at the end. The
// SDKs are replaced by recorders of what each adapter asks of them; the
// adapters are otherwise the real ones, started as the bridge starts them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatAdapter } from "./chat-adapter.js";
import type { AgentConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";

const sdk = vi.hoisted(() => ({
  // Discord: what the bot did in the DM, in order.
  discord: [] as string[],
  discordHandlers: new Map<string, (msg: unknown) => Promise<void>>(),
  telegram: [] as unknown[][],
  telegramFail: new Set<string>(),
  slack: [] as unknown[][],
  slackFail: new Set<string>(),
}));

vi.mock("discord.js", () => {
  let next = 0;
  const dm = {
    isDMBased: () => true,
    type: 1,
    sendTyping: async () => {
      sdk.discord.push("typing");
    },
    send: async (payload: unknown) => {
      next += 1;
      const id = next;
      sdk.discord.push(`send#${id} ${JSON.stringify(payload)}`);
      return {
        edit: async (text: string) => {
          sdk.discord.push(`edit#${id} ${text}`);
        },
        delete: async () => {
          sdk.discord.push(`delete#${id}`);
        },
      };
    },
  };
  class Client {
    rest = { get: async () => ({}) };
    users = { fetch: async () => ({ createDM: async () => dm }) };
    on(event: string, handler: (msg: unknown) => Promise<void>) {
      sdk.discordHandlers.set(event, handler);
      return this;
    }
    async login() {
      return "token";
    }
    isReady() {
      return true;
    }
    async destroy() {}
  }
  return {
    Client,
    Events: { MessageCreate: "messageCreate", Error: "error" },
    GatewayIntentBits: { DirectMessages: 1, MessageContent: 2, Guilds: 3 },
    Partials: { Channel: 1, Message: 2 },
    Routes: { gateway: () => "/gateway" },
    __dm: dm,
  };
});

vi.mock("telegraf", () => {
  let next = 100;
  const call = (name: string, args: unknown[]) => {
    if (sdk.telegramFail.has(name)) throw new Error(`telegram refused ${name}`);
    sdk.telegram.push([name, ...args]);
  };
  class Telegraf {
    telegram = {
      sendMessage: async (chatId: string, text: string, extra?: Record<string, unknown>) => {
        call("sendMessage", [chatId, text, extra]);
        next += 1;
        return { message_id: next, chat: { id: Number(chatId) } };
      },
      editMessageText: async (...args: unknown[]) => call("editMessageText", args),
      deleteMessage: async (...args: unknown[]) => call("deleteMessage", args),
      sendChatAction: async () => true,
    };
    on() {}
    catch() {}
    launch(_opts?: unknown, onLaunch?: () => void) {
      onLaunch?.();
      return new Promise<void>(() => {});
    }
    stop() {}
  }
  return { Telegraf };
});

vi.mock("@slack/bolt", () => {
  const call = (name: string, args: Record<string, unknown>) => {
    if (sdk.slackFail.has(name)) throw new Error(`slack refused ${name}`);
    sdk.slack.push([name, args]);
  };
  class App {
    client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          call("postMessage", args);
          // A post to a user id lands in the direct message Slack opens for it,
          // and the answer names that conversation.
          return { ok: true, channel: "D0DIRECT", ts: "1760000000.000100" };
        },
        update: async (args: Record<string, unknown>) => call("update", args),
        delete: async (args: Record<string, unknown>) => call("delete", args),
      },
    };
    message() {}
    error() {}
    action() {}
    async start() {}
    async stop() {}
  }
  return { App, LogLevel: { WARN: "warn" } };
});

function agent(channel: AgentConfig["channel"], extra: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "agent-1",
    channel,
    allowed_users: ["u1"],
    cwd: "/home/agent/cerase/workspace",
    mode: "cerase",
    spawn: { command: "docker", args: [] },
    ...extra,
  };
}

const NO_DISPATCHER = {} as unknown as Dispatcher;

beforeEach(() => {
  sdk.discord.length = 0;
  sdk.discordHandlers.clear();
  sdk.telegram.length = 0;
  sdk.telegramFail.clear();
  sdk.slack.length = 0;
  sdk.slackFail.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("which channels keep a status line", () => {
  it("every channel that can edit a message keeps one, and the console's transport keeps none", async () => {
    const credentials: Partial<Record<AgentConfig["channel"], Partial<AgentConfig>>> = {
      discord: { bot_token: "x" },
      telegram: { bot_token: "123:abc" },
      slack: { bot_token: "xoxb-1", slack_app_token: "xapp-1" },
      workspace_chat: { workspace_chat: { project_number: "123456789012", credentials_path: "/nonexistent.json" } },
    };
    for (const [channel, extra] of Object.entries(credentials)) {
      const adapter = await createChatAdapter(agent(channel as AgentConfig["channel"], extra), NO_DISPATCHER);
      expect(adapter.statusLine, channel).toBeTypeOf("function");
    }
    const web = await createChatAdapter(agent("web"), NO_DISPATCHER);
    expect(web.statusLine).toBeUndefined();
  });
});

describe("Discord: the status line", () => {
  it("is one silent message in the DM, edited in place and deleted, and it leaves the typing indicator to the turn", async () => {
    vi.useFakeTimers();
    let endTurn: () => void = () => {};
    const dispatcher = {
      handleMessage: () =>
        new Promise((resolve) => {
          endTurn = () => resolve({ ok: true });
        }),
    } as unknown as Dispatcher;
    const adapter = await createChatAdapter(agent("discord", { bot_token: "x" }), dispatcher);
    await adapter.start();
    const { __dm: dm } = (await import("discord.js")) as unknown as { __dm: object };
    const handled = sdk.discordHandlers.get("messageCreate")!({
      author: { bot: false, id: "u1" },
      guildId: null,
      content: "mi riassumi il foglio?",
      attachments: new Map(),
      channel: dm,
      react: async () => {},
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(sdk.discord).toEqual(["typing"]);

    const line = adapter.statusLine!("u1")!;
    await line.show("Sto leggendo un foglio Google…");
    await line.show("Sto modificando un file…");
    expect(sdk.discord.slice(1)).toEqual([
      `send#1 ${JSON.stringify({ content: "Sto leggendo un foglio Google…", flags: "SuppressNotifications" })}`,
      "edit#1 Sto modificando un file…",
    ]);

    // The keepalive goes on refreshing under the status message.
    await vi.advanceTimersByTimeAsync(7_000);
    expect(sdk.discord.at(-1)).toBe("typing");

    // The answer is what takes the indicator down, as before.
    expect(await adapter.makeSendTarget("u1")("Ecco il riepilogo.")).toEqual({ ok: true });
    const answered = sdk.discord.length;
    await vi.advanceTimersByTimeAsync(21_000);
    expect(sdk.discord.length).toBe(answered);

    await line.close();
    expect(sdk.discord.slice(answered - 1)).toEqual(['send#2 "Ecco il riepilogo."', "delete#1"]);
    endTurn();
    await handled;
    await adapter.stop();
  });
});

describe("Telegram: the status line", () => {
  it("is one message sent without a notification, edited in place and deleted", async () => {
    const adapter = await createChatAdapter(agent("telegram", { bot_token: "123:abc" }), NO_DISPATCHER);
    await adapter.start();
    const line = adapter.statusLine!("42")!;
    await line.show("Sto leggendo un foglio Google…");
    await line.show("Sto modificando un file…");
    await line.close();
    expect(sdk.telegram).toEqual([
      ["sendMessage", "42", "Sto leggendo un foglio Google…", { disable_notification: true }],
      ["editMessageText", "42", 101, undefined, "Sto modificando un file…"],
      ["deleteMessage", "42", 101],
    ]);
    await adapter.stop();
  });

  it("costs nothing when Telegram refuses an edit: the line is still deleted at the end", async () => {
    const adapter = await createChatAdapter(agent("telegram", { bot_token: "123:abc" }), NO_DISPATCHER);
    await adapter.start();
    sdk.telegramFail.add("editMessageText");
    const line = adapter.statusLine!("42")!;
    await line.show("Sto leggendo un foglio Google…");
    await expect(line.show("Sto modificando un file…")).resolves.toBeUndefined();
    await line.close();
    expect(sdk.telegram.map((c) => c[0])).toEqual(["sendMessage", "deleteMessage"]);
    await adapter.stop();
  });
});

describe("Slack: the status line", () => {
  it("is one message, edited and deleted in the conversation Slack answered the post with", async () => {
    const adapter = await createChatAdapter(
      agent("slack", { bot_token: "xoxb-1", slack_app_token: "xapp-1" }),
      NO_DISPATCHER,
    );
    await adapter.start();
    const line = adapter.statusLine!("U1")!;
    await line.show("Sto leggendo un foglio Google…");
    await line.show("Sto modificando un file…");
    await line.close();
    expect(sdk.slack).toEqual([
      ["postMessage", { channel: "U1", text: "Sto leggendo un foglio Google…" }],
      ["update", { channel: "D0DIRECT", ts: "1760000000.000100", text: "Sto modificando un file…" }],
      ["delete", { channel: "D0DIRECT", ts: "1760000000.000100" }],
    ]);
    await adapter.stop();
  });

  it("posts no second message after Slack refused the first, and has nothing to delete", async () => {
    const adapter = await createChatAdapter(
      agent("slack", { bot_token: "xoxb-1", slack_app_token: "xapp-1" }),
      NO_DISPATCHER,
    );
    await adapter.start();
    sdk.slackFail.add("postMessage");
    const line = adapter.statusLine!("U1")!;
    await expect(line.show("Sto leggendo un foglio Google…")).resolves.toBeUndefined();
    sdk.slackFail.clear();
    await line.show("Sto modificando un file…");
    await line.close();
    expect(sdk.slack).toEqual([]);
    await adapter.stop();
  });
});

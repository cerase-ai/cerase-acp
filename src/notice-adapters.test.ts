// Each chat adapter sends a platform notice in its channel's own box: the
// payload it hands its SDK is the one platform-notice.ts builds for that
// channel, and never the notice as a line of text beside the assistant's own.
//
// The SDKs are replaced by recorders of what each adapter asks of them. The
// adapters are otherwise the real ones, started as the bridge starts them.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChatAdapter } from "./chat-adapter.js";
import type { AgentConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";
import {
  discordNoticeMessages,
  type PlatformNotice,
  SLACK_NOTICE_ACTION_ID,
  slackNoticeMessage,
  telegramNoticeMessages,
} from "./platform-notice.js";

const sdk = vi.hoisted(() => ({
  discordSends: [] as unknown[],
  discordFail: undefined as Error | undefined,
  slackPosts: [] as Record<string, unknown>[],
  slackActions: new Map<string, (args: { ack: () => Promise<void> }) => Promise<void>>(),
  telegramSends: [] as Array<{ chatId: string; text: string; extra: Record<string, unknown> | undefined }>,
  telegramRefusals: [] as Error[],
}));

vi.mock("discord.js", () => {
  class Client {
    rest = { get: async () => ({}) };
    users = {
      fetch: async () => ({
        createDM: async () => ({
          send: async (payload: unknown) => {
            if (sdk.discordFail) throw sdk.discordFail;
            sdk.discordSends.push(payload);
            return {};
          },
        }),
      }),
    };
    on() {
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
  };
});

vi.mock("@slack/bolt", () => {
  class App {
    client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          sdk.slackPosts.push(args);
          return { ok: true };
        },
      },
    };
    message() {}
    error() {}
    action(id: string, handler: (args: { ack: () => Promise<void> }) => Promise<void>) {
      sdk.slackActions.set(id, handler);
    }
    async start() {}
    async stop() {}
  }
  return { App, LogLevel: { WARN: "warn" } };
});

vi.mock("telegraf", () => {
  class Telegraf {
    telegram = {
      sendMessage: async (chatId: string, text: string, extra?: Record<string, unknown>) => {
        const refusal = sdk.telegramRefusals.shift();
        if (refusal) throw refusal;
        sdk.telegramSends.push({ chatId, text, extra });
        return {};
      },
      sendChatAction: async () => true,
      getMe: async () => ({ id: 1, username: "assistente_bot" }),
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

const DISPATCHER = {} as unknown as Dispatcher;

const NOTICE: PlatformNotice = {
  title: "Richiesta di approvazione",
  body: "«Matilde» chiede la tua approvazione per: invia una mail\n- A: anna@example.com",
  link: { url: "https://acme.cerase.ai/a/Xy7Kq2", label: "Approva o rifiuta" },
};

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

beforeEach(() => {
  sdk.discordSends.length = 0;
  sdk.discordFail = undefined;
  sdk.slackPosts.length = 0;
  sdk.slackActions.clear();
  sdk.telegramSends.length = 0;
  sdk.telegramRefusals.length = 0;
});

describe("Discord adapter: a notice is an embed with its link in a button", () => {
  it("sends the embed and the button, and nothing as plain text", async () => {
    const adapter = await createChatAdapter(agent("discord", { bot_token: "x" }), DISPATCHER);
    await adapter.start();
    try {
      expect(adapter.sendNotice).toBeTypeOf("function");
      const result = await adapter.sendNotice!("u1", NOTICE);
      expect(result).toEqual({ ok: true });
      expect(sdk.discordSends).toEqual(discordNoticeMessages(NOTICE));
      expect(typeof sdk.discordSends[0]).toBe("object");
    } finally {
      await adapter.stop();
    }
  });

  it("returns a refused send as a failure instead of throwing", async () => {
    const adapter = await createChatAdapter(agent("discord", { bot_token: "x" }), DISPATCHER);
    await adapter.start();
    try {
      sdk.discordFail = new Error("Missing Access");
      const result = await adapter.sendNotice!("u1", NOTICE);
      expect(result.ok).toBe(false);
    } finally {
      await adapter.stop();
    }
  });
});

describe("Slack adapter: a notice is blocks with its link in a button", () => {
  it("posts the blocks with the notice spelled out as the notification's text", async () => {
    const adapter = await createChatAdapter(
      agent("slack", { bot_token: "xoxb-1", slack_app_token: "xapp-1" }),
      DISPATCHER,
    );
    await adapter.start();
    try {
      expect(adapter.sendNotice).toBeTypeOf("function");
      const result = await adapter.sendNotice!("U1", NOTICE);
      expect(result).toEqual({ ok: true });
      const { text, blocks } = slackNoticeMessage(NOTICE);
      expect(sdk.slackPosts).toEqual([{ channel: "U1", text, blocks, unfurl_links: false, unfurl_media: false }]);
    } finally {
      await adapter.stop();
    }
  });

  it("acknowledges a click on the button, which Slack reports to the app as well as opening the link", async () => {
    const adapter = await createChatAdapter(
      agent("slack", { bot_token: "xoxb-1", slack_app_token: "xapp-1" }),
      DISPATCHER,
    );
    await adapter.start();
    try {
      const handler = sdk.slackActions.get(SLACK_NOTICE_ACTION_ID);
      expect(handler).toBeTypeOf("function");
      const ack = vi.fn(async () => {});
      await handler!({ ack });
      expect(ack).toHaveBeenCalledTimes(1);
    } finally {
      await adapter.stop();
    }
  });
});

describe("Telegram adapter: a notice is a quoted block under a bold heading, with its link in a button", () => {
  it("sends the HTML with an inline button", async () => {
    const adapter = await createChatAdapter(agent("telegram", { bot_token: "123:abc" }), DISPATCHER);
    await adapter.start();
    try {
      expect(adapter.sendNotice).toBeTypeOf("function");
      const result = await adapter.sendNotice!("42", NOTICE);
      expect(result).toEqual({ ok: true });
      const [m] = telegramNoticeMessages(NOTICE);
      expect(sdk.telegramSends).toEqual([
        {
          chatId: "42",
          text: m!.html,
          extra: {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
            reply_markup: {
              inline_keyboard: [[{ text: "Approva o rifiuta", url: "https://acme.cerase.ai/a/Xy7Kq2" }]],
            },
          },
        },
      ]);
    } finally {
      await adapter.stop();
    }
  });

  it("sends it again with the address spelled out when Telegram refuses the button", async () => {
    const adapter = await createChatAdapter(agent("telegram", { bot_token: "123:abc" }), DISPATCHER);
    await adapter.start();
    try {
      sdk.telegramRefusals.push(
        Object.assign(new Error("400: Bad Request: BUTTON_URL_INVALID"), {
          response: { error_code: 400, description: "Bad Request: BUTTON_URL_INVALID" },
        }),
      );
      const result = await adapter.sendNotice!("42", NOTICE);
      expect(result).toEqual({ ok: true });
      const [m] = telegramNoticeMessages(NOTICE, true);
      expect(sdk.telegramSends).toEqual([
        { chatId: "42", text: m!.html, extra: { parse_mode: "HTML", link_preview_options: { is_disabled: true } } },
      ]);
      expect(m!.html).toContain("https://acme.cerase.ai/a/Xy7Kq2");
    } finally {
      await adapter.stop();
    }
  });

  it("does not resend for a refusal that is not about the button", async () => {
    const adapter = await createChatAdapter(agent("telegram", { bot_token: "123:abc" }), DISPATCHER);
    await adapter.start();
    try {
      sdk.telegramRefusals.push(
        Object.assign(new Error("403: Forbidden: bot was blocked by the user"), {
          response: { error_code: 403, description: "Forbidden: bot was blocked by the user" },
        }),
      );
      const result = await adapter.sendNotice!("42", NOTICE);
      expect(result.ok).toBe(false);
      expect(sdk.telegramSends).toEqual([]);
    } finally {
      await adapter.stop();
    }
  });
});

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
  discordClosedComponents,
  discordNoticeMessages,
  type NoticeRef,
  type PlatformNotice,
  SLACK_NOTICE_ACTION_ID,
  slackNoticeMessage,
  telegramClosedNoticeMessage,
  telegramNoticeMessages,
} from "./platform-notice.js";

const sdk = vi.hoisted(() => ({
  discordSends: [] as unknown[],
  discordFail: undefined as Error | undefined,
  discordEdits: [] as Array<{ channelId: string; messageId: string; payload: unknown }>,
  discordEditFail: undefined as Error | undefined,
  slackPosts: [] as Record<string, unknown>[],
  slackUpdates: [] as Record<string, unknown>[],
  slackActions: new Map<string, (args: { ack: () => Promise<void> }) => Promise<void>>(),
  telegramSends: [] as Array<{ chatId: string; text: string; extra: Record<string, unknown> | undefined }>,
  telegramEdits: [] as Array<{ chatId: string; messageId: number; text: string; extra: unknown }>,
  telegramRefusals: [] as Error[],
}));

vi.mock("discord.js", () => {
  class Client {
    rest = { get: async () => ({}) };
    users = {
      fetch: async () => ({
        createDM: async () => ({
          id: "dm-1",
          send: async (payload: unknown) => {
            if (sdk.discordFail) throw sdk.discordFail;
            sdk.discordSends.push(payload);
            return { id: `m-${sdk.discordSends.length}`, channelId: "dm-1" };
          },
        }),
      }),
    };
    // A DM channel fetched by id, as the bridge reaches one after a restart.
    channels = {
      fetch: async (channelId: string) => ({
        id: channelId,
        messages: {
          edit: async (messageId: string, payload: unknown) => {
            if (sdk.discordEditFail) throw sdk.discordEditFail;
            sdk.discordEdits.push({ channelId, messageId, payload });
            return {};
          },
        },
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
        // Slack answers with the direct message's own id, not the user's.
        postMessage: async (args: Record<string, unknown>) => {
          sdk.slackPosts.push(args);
          return { ok: true, channel: "D0SLACKDM", ts: `1760000000.00000${sdk.slackPosts.length}` };
        },
        update: async (args: Record<string, unknown>) => {
          sdk.slackUpdates.push(args);
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
        return { message_id: 700 + sdk.telegramSends.length, chat: { id: Number(chatId) } };
      },
      editMessageText: async (chatId: string, messageId: number, _inline: unknown, text: string, extra: unknown) => {
        sdk.telegramEdits.push({ chatId, messageId, text, extra });
        return true;
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
  sdk.discordEdits.length = 0;
  sdk.discordEditFail = undefined;
  sdk.slackPosts.length = 0;
  sdk.slackUpdates.length = 0;
  sdk.slackActions.clear();
  sdk.telegramSends.length = 0;
  sdk.telegramEdits.length = 0;
  sdk.telegramRefusals.length = 0;
});

describe("Discord adapter: a notice is an embed with its link in a button", () => {
  it("sends the embed and the button, and nothing as plain text", async () => {
    const adapter = await createChatAdapter(agent("discord", { bot_token: "x" }), DISPATCHER);
    await adapter.start();
    try {
      expect(adapter.sendNotice).toBeTypeOf("function");
      const result = await adapter.sendNotice!("u1", NOTICE);
      expect(result).toEqual({ ok: true, ref: { channel: "discord", channelId: "dm-1", messageId: "m-1" } });
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
      expect(result).toEqual({ ok: true, ref: { channel: "slack", channelId: "D0SLACKDM", ts: "1760000000.000001" } });
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
      expect(result).toEqual({ ok: true, ref: { channel: "telegram", chatId: "42", messageId: 701 } });
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
      expect(result).toEqual({ ok: true, ref: { channel: "telegram", chatId: "42", messageId: 701 } });
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

// A notice closed once what it asked for is decided: the message that carried
// the button is edited where it is, its button reads how the notice ended and
// can no longer be pressed, and the rest of it stays as it was. The reference
// is the one sendNotice answered, handed back by the control-plane, which may
// be after a restart of the bridge.
describe("closing a notice, on every channel", () => {
  it("Discord: the last message of a long notice is the one named, since it carries the button", async () => {
    const adapter = await createChatAdapter(agent("discord", { bot_token: "x" }), DISPATCHER);
    await adapter.start();
    try {
      const long = {
        ...NOTICE,
        body: Array.from({ length: 12 }, (_, i) => `- riga ${i}: ${"x".repeat(3000)}`).join("\n"),
      };
      const result = await adapter.sendNotice!("u1", long);
      const sent = discordNoticeMessages(long).length;
      expect(sent).toBeGreaterThan(1);
      expect(result).toEqual({ ok: true, ref: { channel: "discord", channelId: "dm-1", messageId: `m-${sent}` } });
    } finally {
      await adapter.stop();
    }
  });

  it("Discord: the button reads how it ended and is disabled, and only the components are edited", async () => {
    const adapter = await createChatAdapter(agent("discord", { bot_token: "x" }), DISPATCHER);
    await adapter.start();
    try {
      expect(adapter.closeNotice).toBeTypeOf("function");
      const ref: NoticeRef = { channel: "discord", channelId: "dm-9", messageId: "m-4" };
      const result = await adapter.closeNotice!(ref, NOTICE, "✓ Approvata");
      expect(result).toEqual({ ok: true });
      expect(sdk.discordEdits).toEqual([
        {
          channelId: "dm-9",
          messageId: "m-4",
          payload: { components: discordClosedComponents(NOTICE, "✓ Approvata") },
        },
      ]);
      const [button] = discordClosedComponents(NOTICE, "✓ Approvata")[0]!.components;
      expect(button).toMatchObject({ label: "✓ Approvata", disabled: true });
    } finally {
      await adapter.stop();
    }
  });

  it("Discord: an edit Discord refuses, a deleted message, is returned and never thrown", async () => {
    const adapter = await createChatAdapter(agent("discord", { bot_token: "x" }), DISPATCHER);
    await adapter.start();
    try {
      sdk.discordEditFail = new Error("Unknown Message");
      const result = await adapter.closeNotice!(
        { channel: "discord", channelId: "dm-1", messageId: "m-1" },
        NOTICE,
        "Scaduta",
      );
      expect(result.ok).toBe(false);
    } finally {
      await adapter.stop();
    }
  });

  it("Slack: the button gives way to how it ended, in the direct message Slack named", async () => {
    const adapter = await createChatAdapter(
      agent("slack", { bot_token: "xoxb-1", slack_app_token: "xapp-1" }),
      DISPATCHER,
    );
    await adapter.start();
    try {
      expect(adapter.closeNotice).toBeTypeOf("function");
      const ref: NoticeRef = { channel: "slack", channelId: "D0SLACKDM", ts: "1760000000.000001" };
      const result = await adapter.closeNotice!(ref, NOTICE, "✕ Rifiutata");
      expect(result).toEqual({ ok: true });
      const { text, blocks } = slackNoticeMessage(NOTICE, "✕ Rifiutata");
      expect(sdk.slackUpdates).toEqual([{ channel: "D0SLACKDM", ts: "1760000000.000001", text, blocks }]);
      expect(blocks.some((b) => b.type === "actions")).toBe(false);
      expect(JSON.stringify(blocks)).toContain("✕ Rifiutata");
    } finally {
      await adapter.stop();
    }
  });

  it("Telegram: the button goes and how it ended is written in its place", async () => {
    const adapter = await createChatAdapter(agent("telegram", { bot_token: "123:abc" }), DISPATCHER);
    await adapter.start();
    try {
      expect(adapter.closeNotice).toBeTypeOf("function");
      const ref: NoticeRef = { channel: "telegram", chatId: "42", messageId: 701 };
      const result = await adapter.closeNotice!(ref, NOTICE, "Scaduta");
      expect(result).toEqual({ ok: true });
      expect(sdk.telegramEdits).toEqual([
        {
          chatId: "42",
          messageId: 701,
          text: telegramClosedNoticeMessage(NOTICE, "Scaduta"),
          extra: {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
            reply_markup: { inline_keyboard: [] },
          },
        },
      ]);
      expect(telegramClosedNoticeMessage(NOTICE, "Scaduta")).toContain("Scaduta");
    } finally {
      await adapter.stop();
    }
  });

  it("a reference of another channel is refused, not acted on", async () => {
    const adapter = await createChatAdapter(agent("telegram", { bot_token: "123:abc" }), DISPATCHER);
    await adapter.start();
    try {
      const result = await adapter.closeNotice!({ channel: "slack", channelId: "D1", ts: "1.2" }, NOTICE, "Scaduta");
      expect(result.ok).toBe(false);
      expect(sdk.telegramEdits).toEqual([]);
    } finally {
      await adapter.stop();
    }
  });
});

// CHANNEL-2 (2026-05-31): Telegram chat adapter.
//
// Minimal DM-only adapter implementing the ChatAdapter contract.
// Uses telegraf (Node Telegram Bot API client, MIT) — chosen over
// raw HTTP polling because it handles long-polling reconnect + file
// download lifecycle out of the box, and because OpenACP's reference
// telegram adapter (used as a READING reference, not vendored) is
// also built on telegraf.
//
// Out of scope per the architecture brief:
//   - slash commands (Cerase never surfaces a /command UI to end users)
//   - inline keyboards
//   - edit-in-place streaming chunks
//
// Allowlist enforcement is the dispatcher's responsibility (same as
// Discord); this adapter just hands the user id and text to it.

import { makeLogger } from "./logger.js";
import type { AgentConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";
import type { ChatAdapter } from "./chat-adapter.js";

const logger = makeLogger("cerase-acp.telegram");

export function createTelegramAdapter(
  agent: AgentConfig,
  dispatcher: Dispatcher,
): ChatAdapter {
  if (!agent.bot_token) {
    throw new Error(
      `agent "${agent.id}" channel='telegram' has no bot_token (BotFather token) — caught at config load via superRefine`,
    );
  }

  // Lazy-typed handle on telegraf so the import + type wiring stays
  // out of the runtime closure when no agent uses Telegram.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let bot: any | undefined;
  let stopped = false;

  return {
    agentId: agent.id,
    async start() {
      // Lazy import: only pulled in when the bridge actually instantiates
      // a Telegram adapter. Avoids loading the telegraf dependency in
      // appliances configured solely for Discord / Slack / Workspace Chat.
      const { Telegraf } = await import("telegraf");
      bot = new Telegraf(agent.bot_token!);

      bot.on("text", async (ctx: { from?: { id: number }; chat?: { id: number }; message?: { text?: string } }) => {
        try {
          // 1:1 DMs only: chat.id === from.id is Telegram's "private
          // chat with this user" invariant. Reject everything else
          // (group chats, channels) so the bot stays scoped to the
          // ChatAdapter DM contract.
          if (!ctx.from || !ctx.chat || ctx.from.id !== ctx.chat.id) return;
          const userId = String(ctx.from.id);
          const text = ctx.message?.text ?? "";
          if (!text) return;
          await dispatcher.handleMessage(agent.id, userId, text);
        } catch (err) {
          logger.error({ err, agentId: agent.id }, "telegram text handler threw");
        }
      });

      // Attachment handling lives entirely in the
      // `message-attachment-receiver` skill on the agent side; the
      // bridge forwards the Telegram file_id reference in the same
      // shape the Discord adapter forwards an attachment URL. The
      // per-channel parity is handled in the upload-receiver skill,
      // not here.

      bot.catch((err: unknown) => {
        logger.error({ err, agentId: agent.id }, "telegraf reported error");
      });

      // launch() uses long-polling by default — works behind any
      // outbound-only egress without exposing a public webhook.
      // We await `bot.launch()` indirectly: telegraf's launch resolves
      // only on stop, so we kick it off without awaiting completion.
      bot.launch().catch((err: unknown) => {
        if (!stopped) {
          logger.error({ err, agentId: agent.id }, "telegraf launch crashed");
        }
      });
      logger.info({ agentId: agent.id }, "telegraf bot ready (long-polling)");
    },
    async stop() {
      stopped = true;
      try {
        bot?.stop("SIGTERM");
      } catch (err) {
        logger.warn({ err, agentId: agent.id }, "error during telegram bot stop");
      }
    },
    makeSendTarget(userId: string) {
      return async (chunk: string) => {
        if (!bot) {
          throw new Error(
            `telegram adapter for agent "${agent.id}" not started — refusing to sendMessage`,
          );
        }
        // telegraf's Telegram API client lives at bot.telegram. The
        // sendMessage method takes a chat_id (string for our purposes)
        // and the text. No parse_mode → Telegram renders plain text,
        // which matches the Discord adapter's no-formatting contract.
        await bot.telegram.sendMessage(userId, chunk);
      };
    },
  };
}

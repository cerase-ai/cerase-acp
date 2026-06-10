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
import { startTypingKeepalive } from "./typing-keepalive.js";
import type { AgentConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";
import type { ChatAdapter } from "./chat-adapter.js";
import { ingestInboundAttachments, prependUploadMarker } from "./inbound-attachments.js";
import { extractTelegramFiles } from "./channel-attachments.js";

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
          // M-ACP-2: Telegram shows "typing…" ~5s per sendChatAction —
          // keep it alive for the duration of the turn, stopping on
          // every exit path. Slack/Workspace Chat have NO bot-typing
          // API for non-Socket-Mode... (Slack: typing events are
          // RTM-only, deprecated; Workspace Chat: no API) — documented
          // platform limit, no equivalent there.
          const chatId = ctx.chat.id;
          const stopTyping = startTypingKeepalive(
            { sendTyping: () => bot.telegram.sendChatAction(chatId, "typing") },
            // Telegram displays a chat action for ~5s (Discord ~10s) —
            // tick inside that window so the indicator never flickers.
            { intervalMs: 4_000, maxTicks: 75 },
          );
          try {
            await dispatcher.handleMessage(agent.id, userId, text);
          } finally {
            stopTyping();
          }
        } catch (err) {
          logger.error({ err, agentId: agent.id }, "telegram text handler threw");
        }
      });

      // C4-4 — inbound attachments. Telegram delivers media as separate
      // update types (document/photo/voice/audio/video), each carrying a
      // file_id we resolve to a download URL via getFileLink, then run through
      // the shared ingest + the [Uploaded files: …] marker the
      // message-attachment-receiver skill reads. The caption is the body text.
      const mediaHandler = async (ctx: {
        from?: { id: number };
        chat?: { id: number };
        message?: Record<string, unknown> & { caption?: string };
        telegram: { getFileLink(fileId: string): Promise<URL> };
      }) => {
        try {
          if (!ctx.from || !ctx.chat || ctx.from.id !== ctx.chat.id) return;
          const userId = String(ctx.from.id);
          const caption = ctx.message?.caption ?? "";
          const refs = extractTelegramFiles(ctx.message);
          const files: { name: string; url: string }[] = [];
          for (const ref of refs) {
            try {
              const link = await ctx.telegram.getFileLink(ref.fileId);
              files.push({ name: ref.name, url: link.href });
            } catch (err) {
              logger.warn({ err, agentId: agent.id, fileId: ref.fileId }, "telegram getFileLink failed — skipped");
            }
          }
          const relPaths = await ingestInboundAttachments(`cerase-${agent.id}`, files);
          const text = prependUploadMarker(caption, relPaths);
          if (!text) return; // nothing downloaded and no caption
          await dispatcher.handleMessage(agent.id, userId, text);
        } catch (err) {
          logger.error({ err, agentId: agent.id }, "telegram media handler threw");
        }
      };
      for (const kind of ["document", "photo", "voice", "audio", "video"]) {
        bot.on(kind, mediaHandler);
      }

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

// Slack chat adapter: one Slack app per agent, direct messages only, through
// @slack/bolt in Socket Mode, so the appliance exposes no public webhook: the
// app opens the websocket to Slack.
//
// The app needs a bot token (xoxb-…) and an app-level token (xapp-…) in
// agents.yaml; its setup and scopes are in cerase-core's
// docs/operator/slack-setup.md. A file the person shares is downloaded with
// the bot token into the slot's workspace. Slack shows no typing indicator for
// the turn, and the adapter has no sendFile, so a file the assistant attaches
// is not sent and the bridge tells the person.
//
// A platform notice is posted as Block Kit blocks with its link in a URL
// button (platform-notice.ts). Slack reports a click on that button to the app
// as well as opening the link, and shows the person a warning when the app
// does not acknowledge it, so the adapter acknowledges that one action and
// does nothing else with it.
//
// Not handled: channel posts, threads, slash commands, interactive components
// other than the notice's link button, and the App Home tab.

import type { App } from "@slack/bolt";
import { extractSlackFiles } from "./channel-attachments.js";
import type { ChatAdapter, DeliveryResult } from "./chat-adapter.js";
import type { AgentConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";
import { buildOversizeNotice, ingestInboundAttachments, prependUploadMarker } from "./inbound-attachments.js";
import { makeLogger } from "./logger.js";
import { type PlatformNotice, SLACK_NOTICE_ACTION_ID, slackNoticeMessage } from "./platform-notice.js";
import { detectLanguage } from "./turn-meta.js";

const logger = makeLogger("cerase-acp.slack");

export function createSlackAdapter(agent: AgentConfig, dispatcher: Dispatcher): ChatAdapter {
  if (!agent.bot_token || !agent.slack_app_token) {
    throw new Error(
      `agent "${agent.id}" channel='slack' missing bot_token or slack_app_token — should have been caught at config load via superRefine`,
    );
  }

  // Lazy-loaded SDK client. Real @slack/bolt App type — default
  // StringIndexed generic matches the untyped message payloads below.
  let app: App | undefined;

  return {
    agentId: agent.id,
    async start() {
      const { App, LogLevel } = await import("@slack/bolt");
      app = new App({
        token: agent.bot_token,
        appToken: agent.slack_app_token,
        socketMode: true,
        // Defensive: never log incoming payloads at debug level — they
        // contain user-typed text we don't want spilling into journald.
        logLevel: LogLevel.WARN,
      });

      // im.message = direct-message-to-our-bot. Slack also fires
      // `message` events for channel posts and threads; we filter to
      // channel_type === "im" so only DMs reach the dispatcher.
      app.message(async (args) => {
        try {
          const m = args.message;
          if (m.channel_type !== "im") return;
          // Allow the `file_share` subtype (it carries the uploaded files);
          // still drop edited/deleted/bot-reply subtypes.
          if (m.subtype && m.subtype !== "file_share") return;
          const userId = typeof m.user === "string" ? m.user : undefined;
          const text = typeof m.text === "string" ? m.text : "";
          const slackFiles = extractSlackFiles(m);
          if (!userId || (!text && slackFiles.length === 0)) return;

          // Slack file URLs (url_private) require the bot token to download.
          let outText = text;
          if (slackFiles.length > 0) {
            const { stored, rejected } = await ingestInboundAttachments(`cerase-${agent.id}`, slackFiles, "slack", {
              headers: { Authorization: `Bearer ${agent.bot_token}` },
            });
            outText = prependUploadMarker(text, stored);
            // Tell the user about over-cap files
            // instead of dropping them silently; the stored files still flow.
            const notice = buildOversizeNotice(rejected, "slack", detectLanguage(text));
            if (notice) {
              await dispatcher.sendSystemMessage(agent.id, userId, notice);
            }
          }
          await dispatcher.handleMessage(agent.id, userId, outText);
        } catch (err) {
          logger.error({ err, agentId: agent.id }, "slack message handler threw");
        }
      });

      // The notice's button opens its link in the browser; the click Slack
      // also reports here only needs its acknowledgement.
      app.action(SLACK_NOTICE_ACTION_ID, async ({ ack }) => {
        await ack();
      });

      app.error(async (err: unknown) => {
        logger.error({ err, agentId: agent.id }, "@slack/bolt reported error");
      });

      await app.start();
      logger.info({ agentId: agent.id }, "@slack/bolt Socket Mode ready");
    },
    async stop() {
      try {
        await app?.stop();
      } catch (err) {
        logger.warn({ err, agentId: agent.id }, "error during slack app stop");
      }
    },
    async sendNotice(userId: string, notice: PlatformNotice): Promise<DeliveryResult> {
      try {
        if (!app) {
          throw new Error(`slack adapter for agent "${agent.id}" not started — refusing to postMessage`);
        }
        const { text, blocks } = slackNoticeMessage(notice);
        // `text` is the notice spelled out, which is what a notification shows.
        // No unfurl: the button is the link, and a preview card under it would
        // be a second box saying the same thing.
        // The blocks are built SDK-free in platform-notice.ts, in Block Kit's
        // own JSON, so they are typed here as the call takes them.
        const post = app.client.chat.postMessage.bind(app.client.chat);
        await post({
          channel: userId,
          text,
          blocks,
          unfurl_links: false,
          unfurl_media: false,
        } as unknown as Parameters<typeof post>[0]);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
      }
    },
    makeSendTarget(userId: string) {
      return async (chunk: string): Promise<DeliveryResult> => {
        // A postMessage failure (or a "not started" state)
        // is returned as `{ ok: false }` rather than thrown, so the failure
        // travels up the SendQueue → Dispatcher → inject status truthfully.
        try {
          if (!app) {
            throw new Error(`slack adapter for agent "${agent.id}" not started — refusing to postMessage`);
          }
          // Slack's chat.postMessage with channel=<user-id> opens (or
          // reuses) the user's IM channel automatically. No need to
          // pre-resolve via conversations.open.
          await app.client.chat.postMessage({
            channel: userId,
            text: chunk,
          });
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
        }
      };
    },
  };
}

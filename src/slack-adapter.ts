// CHANNEL-3 (2026-05-31): Slack chat adapter.
//
// Minimal DM-only adapter implementing the ChatAdapter contract.
// Uses @slack/bolt in Socket Mode so the appliance does NOT need
// to expose a public webhook on Traefik — Slack initiates the
// websocket connection from us outward.
//
// Per-tenant Slack-app setup (operator runbook in
// docs/operator/slack-setup.md): create a Slack app, scopes
// chat:write + im:history + im:read + im:write, install to
// workspace, copy bot xoxb-… token + app-level xapp-… token into
// agents.yaml via env substitution.
//
// Out of scope per the architecture brief:
//   - channel posts (group rooms)
//   - threading
//   - slash commands
//   - Block Kit interactive components
//   - App Home tab

import { makeLogger } from "./logger.js";
import type { AgentConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";
import type { ChatAdapter } from "./chat-adapter.js";

const logger = makeLogger("cerase-acp.slack");

export function createSlackAdapter(
  agent: AgentConfig,
  dispatcher: Dispatcher,
): ChatAdapter {
  if (!agent.bot_token || !agent.slack_app_token) {
    throw new Error(
      `agent "${agent.id}" channel='slack' missing bot_token or slack_app_token — should have been caught at config load via superRefine`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any | undefined;

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
      app.message(async (args: { message: Record<string, unknown> }) => {
        try {
          const m = args.message;
          if (m.channel_type !== "im") return;
          if (m.subtype) return; // edited / deleted / bot reply etc.
          const userId = typeof m.user === "string" ? m.user : undefined;
          const text = typeof m.text === "string" ? m.text : "";
          if (!userId || !text) return;
          await dispatcher.handleMessage(agent.id, userId, text);
        } catch (err) {
          logger.error({ err, agentId: agent.id }, "slack message handler threw");
        }
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
    makeSendTarget(userId: string) {
      return async (chunk: string) => {
        if (!app) {
          throw new Error(
            `slack adapter for agent "${agent.id}" not started — refusing to postMessage`,
          );
        }
        // Slack's chat.postMessage with channel=<user-id> opens (or
        // reuses) the user's IM channel automatically. No need to
        // pre-resolve via conversations.open.
        await app.client.chat.postMessage({
          channel: userId,
          text: chunk,
        });
      };
    },
  };
}

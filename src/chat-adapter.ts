// CHANNEL-1 (2026-05-31): the cross-channel adapter contract.
//
// Each chat-channel implementation (discord, telegram, slack,
// workspace_chat) returns a ChatAdapter — same interface the original
// DiscordAdapter shipped, generalised across channels. The bridge
// stores them in `Map<agentId, ChatAdapter>` and the dispatcher
// reaches the user via `adapter.makeSendTarget(userId)`. Adding a new
// channel = adding one file + one switch case in `createChatAdapter`.
//
// The dispatcher, session-manager, allowlist, turn-meta, prompt-queue,
// send-queue, typing-keepalive — everything else — is channel-agnostic
// and unchanged. The whole point of the milestone: NO special cases
// for non-Discord channels; the per-channel surface area is one small
// adapter file each.

import type { AgentConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";

export interface ChatAdapter {
  agentId: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The function the dispatcher uses to send a chunk to this user's DM. */
  makeSendTarget(userId: string): (chunk: string) => Promise<void>;
}

/**
 * Factory dispatching on `agent.channel`. Each branch lazy-imports its
 * adapter file so unused channels don't pull their transport deps
 * (discord.js, telegraf, @slack/bolt, @google-apis/chat) into the
 * runtime closure when no agent uses that channel.
 *
 * Returned promise resolves to a fully constructed (but NOT started)
 * adapter — bridge.ts calls `adapter.start()` separately so it can
 * group failures and apply the test-mode resilience contract.
 */
export async function createChatAdapter(
  agent: AgentConfig,
  dispatcher: Dispatcher,
): Promise<ChatAdapter> {
  switch (agent.channel) {
    case "discord": {
      const { createDiscordAdapter } = await import("./discord-adapter.js");
      return createDiscordAdapter(agent, dispatcher);
    }
    case "telegram": {
      const { createTelegramAdapter } = await import("./telegram-adapter.js");
      return createTelegramAdapter(agent, dispatcher);
    }
    case "slack": {
      const { createSlackAdapter } = await import("./slack-adapter.js");
      return createSlackAdapter(agent, dispatcher);
    }
    case "workspace_chat": {
      const { createWorkspaceChatAdapter } = await import(
        "./workspace-chat-adapter.js"
      );
      return createWorkspaceChatAdapter(agent, dispatcher);
    }
    default: {
      // Exhaustiveness guard — TypeScript narrows the union, so any new
      // channel added to ChatChannelSchema without a case here is a
      // compile error.
      const _exhaustive: never = agent.channel;
      throw new Error(
        `createChatAdapter: unknown channel ${String(_exhaustive)} for agent "${agent.id}"`,
      );
    }
  }
}

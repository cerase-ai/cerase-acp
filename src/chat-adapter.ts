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
  /**
   * M-BRIDGE-LIVENESS-1 — does the underlying channel client report a live
   * connection right now? The Discord adapter delegates to discord.js
   * `client.isReady()` (true after login, false on a gateway drop), so the
   * control-plane can tell "Attivo ma disconnesso" apart from a healthy
   * agent. An adapter that doesn't implement it is treated as ready while
   * it is held (best-effort — those channels expose no finer signal yet).
   */
  ready?(): boolean;
  /**
   * The function the dispatcher uses to send a chunk to this user's DM.
   *
   * **OPT-67 typing-indicator contract (applies to ALL adapters that
   * surface a "is typing…" UX):**
   *
   *   1. Typing should be visible WHILE chunks are streaming (signals
   *      "still working").
   *   2. Typing must STOP cleanly after the final chunk — no ghost
   *      indicator lingering 5-10s past the actual reply.
   *
   * The pattern used by the Discord adapter (see `discord-adapter.ts`
   * + `typing-keepalive.ts`):
   *
   *   - On MessageCreate: start an interval-based keepalive
   *     (`startTypingKeepalive` → `setInterval` calling the channel's
   *     typing API every 7s). Returns a `stopFn`.
   *   - Inside `makeSendTarget`, **do NOT** call the typing API after
   *     each `channel.send(chunk)`. The keepalive interval already
   *     covers the streaming window; an extra post-send typing call
   *     re-prolongs the indicator past the final chunk → ghost.
   *   - Wrap the dispatcher call in a `try { … } finally { stopFn(); }`
   *     block so the interval is cancelled the moment streaming ends.
   *
   * Telegram (`sendChatAction('typing')`), Slack (assistant.threads.
   * setStatus or similar), Workspace Chat (any future "thinking…"
   * affordance): same shape — keepalive in the message handler, NO
   * per-chunk re-trigger.
   */
  makeSendTarget(userId: string): (chunk: string) => Promise<void>;

  /**
   * CHAT-UX / ATTACH-1 — upload a workspace file as a chat attachment to
   * `userId`. Optional: an adapter that doesn't implement it signals
   * "attachments not supported on this channel" and the bridge degrades
   * to a text note. Discord uses `channel.send({ files })`; Telegram
   * `sendDocument`; Slack `filesUploadV2`; Workspace Chat media upload.
   */
  sendFile?(userId: string, file: OutgoingFile): Promise<void>;
}

/** A file the agent attaches to its chat reply (read from its workspace). */
export interface OutgoingFile {
  name: string;
  bytes: Buffer;
  caption?: string;
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
    case "web": {
      // C2-0 — panel-only null-sink channel (maintainer assistant).
      const { createWebAdapter } = await import("./web-adapter.js");
      return createWebAdapter(agent, dispatcher);
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

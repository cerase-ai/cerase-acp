// The cross-channel adapter contract.
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
import type { ReachabilitySnapshot } from "./reachability.js";

/**
 * The outcome of a single delivery attempt to a chat channel. The adapter
 * delivery methods return this instead of
 * `Promise<void>` so a swallowed failure (e.g. `channel.send` rejecting
 * because the slot is down / the gateway dropped) can be propagated up the
 * stack — through the SendQueue, the Dispatcher, and finally surfaced as a
 * truthful HTTP status on `/internal/inject` — instead of resolving as a
 * blind success. Adapters MUST NOT throw on a send error anymore: they
 * catch it and return `{ ok: false, error }`.
 */
export type DeliveryResult = { ok: true } | { ok: false; error: Error };

export interface ChatAdapter {
  agentId: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Can this adapter carry a message right now? The control-plane renders it
   * as the "Connessione" badge and tells "Attivo ma disconnesso" apart from a
   * healthy agent, and an operator alert is wired to it — so it has to mean
   * reachability, not a cached flag.
   *
   * The Discord adapter answers with both halves: discord.js `client.isReady()`
   * (true after login, false on a gateway drop) AND its reachability
   * measurement below. The flag alone reported a live connection through a
   * five-minute network outage, which is the case a client's view of its own
   * socket structurally cannot see. An adapter that doesn't implement this at
   * all is treated as ready while it is held (best-effort — those channels
   * expose no finer signal yet).
   */
  ready?(): boolean;
  /**
   * What this adapter has measured about the provider answering it: when it
   * last did, and whether that is now old enough to call silence. Optional —
   * an adapter without one reports readiness from its client alone, which is
   * the older and weaker meaning.
   *
   * It is published beside `ready` rather than folded away into it, because
   * the two failures need different answers from an operator: a client that
   * reports a dropped connection is the library's problem to retry, and a
   * client that reports a live one while nothing answers is the network's.
   */
  reachability?(): ReachabilitySnapshot;
  /**
   * The function the dispatcher uses to send a chunk to this user's DM.
   *
   * **OPT-67 typing-indicator contract (applies to ALL adapters that
   * surface a "is typing…" UX):**
   *
   *   1. Typing should be visible while the turn is silent (signals
   *      "still working" before any text has arrived).
   *   2. Typing must be gone the moment the reply lands — no ghost
   *      indicator lingering 5-10s past it.
   *
   * On these platforms the indicator has no "off" call: it comes down
   * because we posted a message, or because its own timeout expired. So
   * the message IS the clear, and the only thing that can undo it is a
   * refresh that reaches the platform afterwards. The whole contract
   * follows from that.
   *
   * The pattern used by the Discord adapter (see `discord-adapter.ts`
   * + `typing-keepalive.ts`):
   *
   *   - On MessageCreate: start an interval-based keepalive through the
   *     adapter's `TypingSessions` registry, keyed by the platform user
   *     id, so the send target can reach it.
   *   - Inside `makeSendTarget`, **await** the registry's `end(userId)`
   *     immediately BEFORE `channel.send(chunk)` — never after, and never
   *     unawaited: a refresh already in flight can otherwise overtake the
   *     message on the wire and re-raise the indicator.
   *   - Do not restart the keepalive between chunks. The send target
   *     cannot know whether another chunk follows, and a refresh issued
   *     after the last one is the ghost again.
   *   - Keep the dispatcher call in a `try { … } finally { stopFn(); }`
   *     block. That is now the leak guard for a turn that delivers
   *     nothing, not the normal exit path.
   *
   * Telegram (`sendChatAction('typing')`), Slack (assistant.threads.
   * setStatus or similar), Workspace Chat (any future "thinking…"
   * affordance): same shape — keepalive in the message handler, cleared
   * by the send that precedes it, NO per-chunk re-trigger.
   */
  makeSendTarget(userId: string): (chunk: string) => Promise<DeliveryResult>;

  /**
   * CHAT-UX / ATTACH-1 — upload a workspace file as a chat attachment to
   * `userId`. Optional: an adapter that doesn't implement it signals
   * "attachments not supported on this channel" and the bridge degrades
   * to a text note. Discord uses `channel.send({ files })`; Telegram
   * `sendDocument`; Slack `filesUploadV2`; Workspace Chat media upload.
   */
  sendFile?(userId: string, file: OutgoingFile): Promise<DeliveryResult>;
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
export async function createChatAdapter(agent: AgentConfig, dispatcher: Dispatcher): Promise<ChatAdapter> {
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
      const { createWorkspaceChatAdapter } = await import("./workspace-chat-adapter.js");
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
      throw new Error(`createChatAdapter: unknown channel ${String(_exhaustive)} for agent "${agent.id}"`);
    }
  }
}

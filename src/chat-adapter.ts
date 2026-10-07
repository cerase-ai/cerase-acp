// The cross-channel adapter contract.
//
// Each channel implementation (discord, telegram, slack, workspace_chat,
// web) returns a ChatAdapter. The bridge stores them in
// `Map<agentId, ChatAdapter>` and the dispatcher reaches the user via
// `adapter.makeSendTarget(userId)`. Adding a channel means adding it to
// ChatChannelSchema, one adapter file and one case in `createChatAdapter`.
//
// The dispatcher, session-manager, allowlist, turn-meta, prompt-queue,
// send-queue and typing-keepalive are channel-agnostic; what a channel does
// differently is in its adapter and in the optional members below.

import type { AgentConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";
import type { PlatformNotice } from "./platform-notice.js";
import type { ReachabilitySnapshot } from "./reachability.js";

/**
 * The outcome of a single delivery attempt to a chat channel. The adapter
 * delivery methods return this instead of `Promise<void>` so a failure (e.g.
 * `channel.send` rejecting because the gateway dropped) reaches the
 * SendQueue and the Dispatcher, and from there the turn's result: the
 * `inject` block of `/internal/status`, or the 500 a `system_message_only`
 * inject answers. Adapters must not throw on a send error: they catch it and
 * return `{ ok: false, error }`.
 *
 * `withheld` is set by the bridge's send path on a chunk it kept out of the
 * chat whole: an internal summary, or tool-call markup and nothing else. The
 * person received nothing from it, and a reply that was only such chunks has
 * not answered them.
 */
export type DeliveryResult = { ok: true; withheld?: true } | { ok: false; error: Error };

/**
 * How a channel that takes each answer as one message cuts it: into one
 * message, unless the answer is larger than one message may be there.
 */
export interface WholeAnswers {
  split(text: string): string[];
}

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
   * measurement below, because a client's view of its own socket can report a
   * live connection through a network outage. An adapter that doesn't
   * implement this is reported as `ready: null` on /internal/status (false
   * after a failed start), and is counted in neither `ready` nor `readyOf` on
   * /healthz.
   */
  ready?(): boolean;
  /**
   * What this adapter has measured about the provider answering it: when it
   * last did, and whether that is now old enough to call silence. Optional:
   * an adapter without one reports readiness from its client alone.
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
   * **Typing-indicator contract, for every adapter that shows an "is
   * typing…" indicator:**
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
   * Telegram (`sendChatAction('typing')`, every 4 s) starts its keepalive in
   * the text handler and stops it in that handler's `finally`, when the turn
   * ends; its send target does not end it. Slack raises no indicator.
   *
   * Workspace Chat has no indicator to raise, so its handler posts a
   * placeholder message instead, a single speech balloon, and the send target
   * rewrites its text to an ellipsis after the turn's first post rather than
   * before: an edit re-raises nothing, and waiting on it would hold the answer
   * up. The placeholder is edited, never deleted, and the answer is always a
   * new message. It is handed to the one send target made for its turn, not
   * kept per user, because two turns from one person each have their own; the
   * handler's `finally` is the same leak guard as above.
   */
  makeSendTarget(userId: string): (chunk: string) => Promise<DeliveryResult>;

  /**
   * Set by a channel where every message is a notification and the reply
   * cannot stream into one, which is Google Chat. The dispatcher then sends an
   * answer once it is complete — when the turn ends, or when the assistant
   * starts a tool, so the text written before the tool runs arrives while it
   * runs — and cuts it with `split` instead of at Discord's 2,000 characters.
   * Absent, the reply goes out in pieces as it streams.
   */
  wholeAnswers?: WholeAnswers;

  /**
   * Upload a workspace file as a chat attachment to `userId`. Discord uses
   * `channel.send({ files })`; the web adapter reports delivery and sends
   * nothing, because the console links the file from the transcript.
   * Optional: on an adapter without it (Telegram, Slack, Workspace Chat) the
   * bridge tells the person the file did not arrive and records the failure
   * against the turn.
   */
  sendFile?(userId: string, file: OutgoingFile): Promise<DeliveryResult>;

  /**
   * Send a notice from the platform, in this channel's own box: a Discord
   * embed, Slack blocks, a Google Chat card, a Telegram quoted block. It names
   * the platform as its sender and carries its link in a button, so the person
   * cannot read it as something the assistant wrote. Optional: an adapter
   * without it is handed the notice spelled out (`noticeText`) as a plain
   * message, which is what the console's own transport receives.
   *
   * It leaves the typing indicator alone. A notice arrives while a turn may
   * still be running, an approval most of all, and the indicator coming back
   * after it is right for a turn that goes on.
   */
  sendNotice?(userId: string, notice: PlatformNotice): Promise<DeliveryResult>;

  /**
   * The status line of the turn this person's message starts: one message,
   * posted once a tool has run a few seconds, edited in place with the step
   * under way, and removed when the turn ends. The dispatcher decides when and
   * what (turn-status.ts); the adapter keeps the message. Discord, Telegram and
   * Slack post, edit and delete a message of their own; Workspace Chat writes
   * the step into the turn's placeholder and ends it as an ellipsis.
   *
   * Asked for once per turn, before the dispatcher's first await, as the send
   * target is, so a channel that hands each turn something of its own (the
   * Workspace Chat placeholder) hands it to the right one. Optional, and it may
   * answer undefined: a channel that cannot edit a message, and the console's
   * transport, which shows the steps from the transcript, get no status at all
   * rather than a message per step.
   *
   * It leaves the typing indicator alone. On Discord the status message clears
   * the indicator as any message does, and the turn's keepalive, which the
   * status does not end, raises it again at its next refresh.
   */
  statusLine?(userId: string): StatusLine | undefined;
}

/**
 * The one message of a turn that says which step the assistant is on. `show`
 * posts it the first time and edits it after; `close` takes it down. Neither
 * rejects: a failure is logged by the adapter and costs the turn nothing.
 */
export interface StatusLine {
  show(text: string): Promise<void>;
  close(): Promise<void>;
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
 * (discord.js, telegraf, @slack/bolt, google-auth-library) into the
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
      // Console-only channel whose replies are discarded (maintainer assistant).
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

// Thin discord.js glue. One Client per configured agent, DM intent
// only, no guild-channel listeners. All real logic lives in Dispatcher
// (which knows nothing about Discord); this file is the smallest
// possible bridge between the two — kept lean so we can verify it
// behaviourally via the cerase repo's e2e-discord bats tier and the
// BRIDGE_E2E_TEST endpoint, without unit-testing discord.js mocks.

import { Client, type DMChannel, Events, GatewayIntentBits, type Message, Partials, Routes } from "discord.js";
import type { ChatAdapter, DeliveryResult } from "./chat-adapter.js";
import type { AgentConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";
import { buildOversizeNotice, ingestInboundAttachments, prependUploadMarker } from "./inbound-attachments.js";
import { makeLogger } from "./logger.js";
import { isChannelReady, ReachabilityMonitor, type ReachabilitySnapshot } from "./reachability.js";
import { detectLanguage } from "./turn-meta.js";
import { TypingSessions } from "./typing-keepalive.js";

const logger = makeLogger("cerase-acp.discord");

// The standalone `DiscordAdapter` interface was generalised into
// `ChatAdapter` (see ./chat-adapter.ts). Kept here as a deprecated alias for
// any caller that imports it by name (mostly the test suite). New code
// should import ChatAdapter.
export type DiscordAdapter = ChatAdapter;

export function createDiscordAdapter(agent: AgentConfig, dispatcher: Dispatcher): ChatAdapter {
  // Cache per-user DM channels so we don't re-resolve on every chunk
  // of a multi-chunk reply.
  const dmChannels = new Map<string, DMChannel>();

  // The typing keepalives currently running, keyed by the Discord user id.
  // The message handler starts one; the send target below is what ends it,
  // and it needs somewhere to look the turn's keepalive up.
  const typing = new TypingSessions();

  // Is Discord answering this adapter? `client.isReady()` cannot say: it is
  // the library's cached view of its own socket, and it reported a live
  // connection for the whole of a five-minute outage. The probe is the
  // unauth'd gateway lookup, the cheapest request Discord serves, and it is
  // deliberately unauthenticated so a refused token shows up as a credential
  // rejection rather than as an unreachable network.
  const reachability = new ReachabilityMonitor({
    probe: () => client.rest.get(Routes.gateway(), { auth: false }),
    intervalMs: Number(process.env.CERASE_ACP_REACHABILITY_INTERVAL_MS ?? "60000"),
    staleAfterMs: Number(process.env.CERASE_ACP_REACHABILITY_STALE_MS ?? "180000"),
    onStale: (snapshot) =>
      logger.error(
        { agentId: agent.id, ageMs: snapshot.ageMs },
        "discord has stopped answering this adapter — the client still reports a live connection, so this agent is reported not-ready until it answers again",
      ),
    onRecovered: () => logger.info({ agentId: agent.id }, "discord is answering this adapter again"),
  });

  const client = new Client({
    intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.Guilds],
    partials: [Partials.Channel, Partials.Message],
  });

  client.on(Events.MessageCreate, async (msg: Message) => {
    try {
      if (msg.author.bot) return;
      // DMs only — drop everything posted in guild channels.
      if (msg.guildId !== null) return;
      const userId = msg.author.id;
      let text = msg.content ?? "";
      // C4-2 — inbound attachments: a file with no caption must NOT be dropped.
      const inbound = [...msg.attachments.values()].map((a) => ({
        name: a.name ?? "file",
        url: a.url,
      }));
      if (!text && inbound.length === 0) return;
      // Cache the channel for future replies.
      if (msg.channel.isDMBased() && msg.channel.type !== undefined) {
        dmChannels.set(userId, msg.channel as DMChannel);
      }
      // M18 — 👀 read-receipt as soon as the bot picks up the DM,
      // before any LLM work starts. Persistent (we never remove it):
      // the typing indicator below carries the "actively working"
      // signal during the turn; the eye marker remains afterwards
      // as a "I saw this message" trace in the conversation history.
      // `.catch` swallows the rare case where Discord refuses the
      // reaction (user blocked the bot mid-flight, channel deleted,
      // etc.) — never crash the message handler over a UX detail.
      void msg.react("👀").catch(() => {});
      // An inbound DM arrived over the gateway, which is stronger evidence
      // than any probe: this socket carried a packet just now.
      reachability.note();
      // C4-2 — download inbound files into the agent workspace + prepend the
      // [Uploaded files: …] marker the message-attachment-receiver skill reads.
      //
      // Ahead of the typing indicator, because the oversize notice is a
      // message and a message is what takes the indicator down: raising it in
      // front of one we are about to send would spend it immediately and
      // leave the model turn behind it with no indicator at all.
      if (inbound.length > 0) {
        const { stored, rejected } = await ingestInboundAttachments(`cerase-${agent.id}`, inbound, "discord");
        text = prependUploadMarker(text, stored);
        // Tell the user about over-cap files instead of dropping them
        // silently; the stored files still flow.
        const notice = buildOversizeNotice(rejected, "discord", detectLanguage(text));
        if (notice) {
          await dispatcher.sendSystemMessage(agent.id, userId, notice);
        }
      }
      // M18 — "Claudia is typing…" while the turn is in flight.
      // Refreshes every 7s (Discord's indicator auto-stops at ~10s),
      // self-terminates after ~5 min as a defensive ceiling, and is ended by
      // the turn's FIRST delivery (see makeSendTarget) rather than by the
      // block below. The `finally` remains the leak guard for a turn that
      // delivers nothing at all — an allowlist refusal whose send failed, a
      // dispatcher throw before any chunk.
      // Skip on PartialGroupDMChannel (bots can't be in group DMs
      // anyway, but the type union forces a narrow). DM and TextChannel
      // both expose `sendTyping`.
      const typingChannel: { sendTyping(): Promise<unknown> } | null =
        "sendTyping" in msg.channel ? (msg.channel as unknown as { sendTyping(): Promise<unknown> }) : null;
      const stopTyping = typingChannel ? typing.start(userId, typingChannel) : async () => {};
      try {
        await dispatcher.handleMessage(agent.id, userId, text);
      } finally {
        void stopTyping();
      }
    } catch (err) {
      logger.error({ err, agentId: agent.id }, "MessageCreate handler threw");
    }
  });

  client.on(Events.Error, (err) => {
    logger.error({ err, agentId: agent.id }, "discord.js client error");
  });

  return {
    agentId: agent.id,
    // The real gateway connection state: true once the client has logged in
    // and the WebSocket is up, false after a drop or before login. This is
    // what tells "Attivo ma disconnesso" apart from a healthy Luigi in the
    // admin.
    ready() {
      // Both halves, because neither covers the other: the client flag catches
      // a socket the library knows it lost, and the measurement catches the
      // library believing a dead socket is alive.
      return isChannelReady(client.isReady(), reachability.snapshot());
    },
    reachability(): ReachabilitySnapshot {
      return reachability.snapshot();
    },
    async start() {
      // bot_token is validated as required for channel='discord' in
      // config.ts superRefine, so the optional-string type assertion
      // is safe here.
      if (!agent.bot_token) {
        throw new Error(
          `agent "${agent.id}" channel='discord' has no bot_token (should have been caught at config load)`,
        );
      }
      await client.login(agent.bot_token);
      // A completed login is a confirmed round-trip, so readiness starts from
      // a measured baseline rather than from an empty one.
      reachability.note();
      reachability.start();
      logger.info({ agentId: agent.id }, "discord.js client ready");
    },
    async stop() {
      reachability.stop();
      try {
        await client.destroy();
      } catch (err) {
        logger.warn({ err, agentId: agent.id }, "error during discord client destroy");
      }
    },
    async sendFile(userId: string, file: { name: string; bytes: Buffer; caption?: string }): Promise<DeliveryResult> {
      // Return the outcome instead of throwing, so the bridge can log +
      // degrade gracefully on an attachment-upload failure.
      try {
        let channel = dmChannels.get(userId);
        if (!channel) {
          const user = await client.users.fetch(userId);
          channel = (await user.createDM()) as DMChannel;
          dmChannels.set(userId, channel);
        }
        // A file upload is a message too, so it clears the indicator on
        // arrival and must be ordered behind the keepalive exactly as a text
        // chunk is.
        await typing.end(userId);
        // CHAT-UX / ATTACH-1: upload the workspace file as a real Discord
        // attachment. `attachment` accepts a Buffer directly.
        await channel.send({
          content: file.caption,
          files: [{ attachment: file.bytes, name: file.name }],
        });
        reachability.note();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
      }
    },
    makeSendTarget(userId: string) {
      return async (chunk: string): Promise<DeliveryResult> => {
        // A failed channel.send (slot down, gateway drop, user blocked the
        // bot) is returned as `{ ok: false }` rather than thrown — the
        // SendQueue retries once, then the failure surfaces all the way to
        // the inject HTTP status instead of being swallowed.
        try {
          let channel = dmChannels.get(userId);
          if (!channel) {
            const user = await client.users.fetch(userId);
            channel = (await user.createDM()) as DMChannel;
            dmChannels.set(userId, channel);
          }
          // The message IS the clear, so it has to be the last thing Discord
          // hears about this turn. Ending the keepalive here — awaited, before
          // the send, not in the handler's `finally` after it — is what makes
          // the order hold: a refresh issued a moment earlier can still be on
          // the wire, and one that lands after the message puts the indicator
          // back up for another ~10s. That, and not a missing stop, is what
          // outlived the reply on a real client.
          //
          // Terminal for the turn: the keepalive is not restarted between
          // chunks. Nothing here knows whether another chunk is coming, and a
          // refresh issued after what turns out to be the last one is the same
          // ghost by another route.
          await typing.end(userId);
          await channel.send(chunk);
          // A delivered message is the same evidence the probe collects, and
          // free — a bridge in conversation barely has to ask.
          reachability.note();
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
        }
      };
    },
  };
}

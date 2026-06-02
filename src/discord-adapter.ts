// Thin discord.js glue. One Client per configured agent, DM intent
// only, no guild-channel listeners. All real logic lives in Dispatcher
// (which knows nothing about Discord); this file is the smallest
// possible bridge between the two — kept lean so we can verify it
// behaviourally via the cerase repo's e2e-discord bats tier and the
// BRIDGE_E2E_TEST endpoint, without unit-testing discord.js mocks.

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type DMChannel,
} from "discord.js";
import { makeLogger } from "./logger.js";
import type { AgentConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";
import { startTypingKeepalive } from "./typing-keepalive.js";
import type { ChatAdapter } from "./chat-adapter.js";

const logger = makeLogger("cerase-acp.discord");

// CHANNEL-1 (2026-05-31): the standalone `DiscordAdapter` interface
// was generalised into `ChatAdapter` (see ./chat-adapter.ts). Kept
// here as a deprecated alias for any caller that imports it by name
// (mostly the test suite). New code should import ChatAdapter.
export type DiscordAdapter = ChatAdapter;

export function createDiscordAdapter(agent: AgentConfig, dispatcher: Dispatcher): ChatAdapter {
  // Cache per-user DM channels so we don't re-resolve on every chunk
  // of a multi-chunk reply.
  const dmChannels = new Map<string, DMChannel>();

  const client = new Client({
    intents: [
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.Guilds,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.on(Events.MessageCreate, async (msg: Message) => {
    try {
      if (msg.author.bot) return;
      // DMs only — drop everything posted in guild channels.
      if (msg.guildId !== null) return;
      const userId = msg.author.id;
      const text = msg.content ?? "";
      if (!text) return;
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
      // M18 — "Claudia is typing…" while the turn is in flight.
      // Refreshes every 7s (Discord's indicator auto-stops at ~10s),
      // self-terminates after ~5 min as a defensive ceiling, and is
      // stopped explicitly in `finally` so it never outlives the
      // dispatcher call (success, allowlist refusal, dispatch throw).
      // Skip on PartialGroupDMChannel (bots can't be in group DMs
      // anyway, but the type union forces a narrow). DM and TextChannel
      // both expose `sendTyping`.
      const typingChannel: { sendTyping(): Promise<unknown> } | null =
        "sendTyping" in msg.channel ? (msg.channel as unknown as { sendTyping(): Promise<unknown> }) : null;
      const stopTyping = typingChannel ? startTypingKeepalive(typingChannel) : () => {};
      try {
        await dispatcher.handleMessage(agent.id, userId, text);
      } finally {
        stopTyping();
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
      logger.info({ agentId: agent.id }, "discord.js client ready");
    },
    async stop() {
      try {
        await client.destroy();
      } catch (err) {
        logger.warn({ err, agentId: agent.id }, "error during discord client destroy");
      }
    },
    makeSendTarget(userId: string) {
      return async (chunk: string) => {
        let channel = dmChannels.get(userId);
        if (!channel) {
          const user = await client.users.fetch(userId);
          channel = (await user.createDM()) as DMChannel;
          dmChannels.set(userId, channel);
        }
        await channel.send(chunk);
        // OPT-67 (2026-06-02): post-send sendTyping removed. Was added
        // in M18 to close the visual gap until the next 7s keepalive
        // tick — but it leaves a ghost typing indicator visible for
        // ~10s after the FINAL chunk of a turn (Discord auto-stop
        // window), which reads as "still thinking" when the agent
        // is actually done. The keepalive setInterval running in
        // parallel from `startTypingKeepalive` covers intermediate
        // chunks just fine (worst-case 7s gap between Discord auto-
        // clear on send and the next keepalive sendTyping). The
        // bridge's MessageCreate `finally` block calls stopTyping()
        // immediately when handleMessage returns, so no tick fires
        // after the last channel.send → typing clears cleanly.
      };
    },
  };
}

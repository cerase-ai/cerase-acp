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

const logger = makeLogger("cerase-acp.discord");

export interface DiscordAdapter {
  agentId: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The function the dispatcher uses to send a chunk to this user's DM. */
  makeSendTarget(userId: string): (chunk: string) => Promise<void>;
}

export function createDiscordAdapter(agent: AgentConfig, dispatcher: Dispatcher): DiscordAdapter {
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
      await dispatcher.handleMessage(agent.id, userId, text);
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
      };
    },
  };
}

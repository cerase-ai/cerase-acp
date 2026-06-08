// C2-0 (2026-06-08): the `web` null-sink channel.
//
// A panel-only agent — the maintainer assistant — has no external chat
// client. Turns arrive via the internal inject endpoint (/internal/inject,
// keyed on a synthetic web user id) and the assistant's reply is persisted
// by opencode and read from the Filament timeline (cerase-core C1-2). So
// this adapter carries NO transport: start/stop are no-ops and the send
// target discards each streamed chunk (debug-logged only).
//
// It exists purely so the dispatcher's `resolveSendTarget(agentId, userId)`
// has a target and `handleMessage` can run a turn — the rest of the
// pipeline (session-manager, prompt-queue, allowlist, turn-meta) is
// channel-agnostic and unchanged, exactly the CHANNEL-1 contract.

import type { AgentConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";
import { makeLogger } from "./logger.js";
import type { ChatAdapter } from "./chat-adapter.js";

const logger = makeLogger("cerase-acp.web-adapter");

export function createWebAdapter(
  agent: AgentConfig,
  _dispatcher: Dispatcher,
): ChatAdapter {
  return {
    agentId: agent.id,
    async start() {
      // No external client to connect.
    },
    async stop() {
      // Nothing to tear down.
    },
    makeSendTarget(userId: string) {
      return async (chunk: string) => {
        // The reply lives in opencode's session DB and is surfaced by the
        // Filament timeline; on the `web` channel there is nowhere else to
        // send it, so the chunk is intentionally discarded.
        logger.debug(
          { agentId: agent.id, userId, chunkLen: chunk.length },
          "web channel: reply chunk discarded (read from the opencode timeline)",
        );
      };
    },
  };
}

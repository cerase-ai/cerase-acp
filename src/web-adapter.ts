// The `web` null-sink channel.
//
// A panel-only agent — the maintainer assistant — has no external chat
// client. Turns arrive via the internal inject endpoint (/internal/inject,
// keyed on a synthetic web user id) and the assistant's reply is persisted
// by opencode and read from the Filament timeline (cerase-core C1-2). So
// this adapter carries NO transport: start/stop are no-ops and the send
// target discards each streamed chunk (debug-logged only).
//
// Attachments work the same way: the console links each `[[attach:]]` file of
// a turn from the transcript, so sendFile reports delivery and sends nothing.
//
// It exists purely so the dispatcher's `resolveSendTarget(agentId, userId)`
// has a target and `handleMessage` can run a turn — the rest of the
// pipeline (session-manager, prompt-queue, allowlist, turn-meta) is
// channel-agnostic and unchanged, exactly the CHANNEL-1 contract.

import type { ChatAdapter, DeliveryResult, OutgoingFile } from "./chat-adapter.js";
import type { AgentConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";
import { makeLogger } from "./logger.js";

const logger = makeLogger("cerase-acp.web-adapter");

export function createWebAdapter(agent: AgentConfig, _dispatcher: Dispatcher): ChatAdapter {
  return {
    agentId: agent.id,
    async start() {
      // No external client to connect.
    },
    async stop() {
      // Nothing to tear down.
    },
    makeSendTarget(userId: string) {
      return async (chunk: string): Promise<DeliveryResult> => {
        // The reply lives in opencode's session DB and is surfaced by the
        // Filament timeline; on the `web` channel there is nowhere else to
        // send it, so the chunk is intentionally discarded.
        logger.debug(
          { agentId: agent.id, userId, chunkLen: chunk.length },
          "web channel: reply chunk discarded (read from the opencode timeline)",
        );
        // Discarding is success for the web channel — the
        // reply is read from the opencode timeline, never from here. Report
        // ok so a maintainer turn is never mislabelled as a delivery failure.
        return { ok: true };
      };
    },
    // The console's Chat links each file a turn attaches from the transcript,
    // where the `[[attach:]]` marker stays, and serves it from the workspace;
    // the bytes have nowhere to go from here. Delivered, then, as a discarded
    // chunk is: reporting the channel as unable to carry files had the
    // assistant tell the person a file it had just linked never arrived.
    async sendFile(userId: string, file: OutgoingFile): Promise<DeliveryResult> {
      logger.debug(
        { agentId: agent.id, userId, file: file.name },
        "web channel: attachment left to the console, which links it from the transcript",
      );
      return { ok: true };
    },
  };
}

// Core message-handling pipeline. Receives (agentId, userId, text) from
// whichever ingress is active (Discord adapter, test-injection HTTP
// endpoint) and orchestrates allowlist → session-manager → stream-
// buffer → send-queue. Knows nothing about Discord — that's what
// `resolveSendTarget` is for.

import pino from "pino";
import type { BridgeConfig } from "./config.js";
import { isAllowed } from "./allowlist.js";
import { SessionManager } from "./session-manager.js";
import { TurnMetaTracker, detectLanguage } from "./turn-meta.js";
import { StreamBuffer } from "./stream-buffer.js";
import { SendQueue } from "./send-queue.js";

const logger = pino({
  name: "cerase-acp.dispatcher",
  level: process.env.CERASE_ACP_LOG_LEVEL ?? "info",
});

type SendTarget = (chunk: string) => Promise<void>;

export interface DispatcherDeps {
  config: BridgeConfig;
  sessionManager: SessionManager;
  turnMeta: TurnMetaTracker;
  /** Returns the function the bridge will call to deliver each chunk. */
  resolveSendTarget: (agentId: string, userId: string) => SendTarget;
}

const REFUSAL: Record<"it" | "en" | "es" | "fr" | "unknown", string> = {
  it: "Non sono ancora autorizzato a parlare con te — chiedi al tuo amministratore.",
  en: "I'm not authorised to talk to you yet — ask your admin.",
  es: "Aún no tengo permiso para hablar contigo — pídeselo a tu administrador.",
  fr: "Je n'ai pas encore le droit de te parler — demande à ton administrateur.",
  unknown: "I'm not authorised to talk to you yet — ask your admin.",
};

/**
 * Picks the polite-refusal copy matching the language detected in
 * `text`. Exported so the CLI (M7) uses the same source of truth as
 * the Discord adapter / test-injection ingress.
 */
export function pickRefusalMessage(text: string): string {
  return REFUSAL[detectLanguage(text)];
}

export class Dispatcher {
  constructor(private deps: DispatcherDeps) {}

  async handleMessage(agentId: string, userId: string, text: string): Promise<void> {
    // Allowlist gate. isAllowed throws on unknown agent id — let that
    // propagate so the adapter logs it as a wiring bug.
    if (!isAllowed(this.deps.config, agentId, userId)) {
      logger.info({ agentId, userId }, "rejected DM: user not in allowlist");
      const send = this.deps.resolveSendTarget(agentId, userId);
      await send(pickRefusalMessage(text));
      return;
    }

    const send = this.deps.resolveSendTarget(agentId, userId);
    const queue = new SendQueue({ send });
    const buffer = new StreamBuffer({
      onFlush: (chunk) => queue.enqueue(chunk),
    });

    const prefix = this.deps.turnMeta.prefix(agentId, userId, text);
    const promptText = prefix + text;

    logger.info({ agentId, userId, textLen: text.length }, "dispatching to session manager");

    try {
      await this.deps.sessionManager.prompt(agentId, userId, promptText, (update) => {
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          buffer.push(update.content.text);
        }
      });
    } finally {
      buffer.end();
      await queue.drain();
    }
  }
}

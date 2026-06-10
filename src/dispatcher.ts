// Core message-handling pipeline. Receives (agentId, userId, text) from
// whichever ingress is active (Discord adapter, test-injection HTTP
// endpoint) and orchestrates allowlist → session-manager → stream-
// buffer → send-queue. Knows nothing about Discord — that's what
// `resolveSendTarget` is for.

import { makeLogger } from "./logger.js";
import type { BridgeConfig } from "./config.js";
import { isAllowed } from "./allowlist.js";
import { SessionManager } from "./session-manager.js";
import { TurnMetaTracker, detectLanguage } from "./turn-meta.js";
import { StreamBuffer } from "./stream-buffer.js";
import { SendQueue } from "./send-queue.js";

const logger = makeLogger("cerase-acp.dispatcher");

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

// M-ACP-1: a turn that throws (opencode crash, ACP rejection, gateway
// abort) must not leave the user staring at 👀 + a stopped typing
// indicator. Localized so non-Italian users aren't replied to in mixed
// language (same detectLanguage source as the refusal copy).
const TURN_ERROR: Record<"it" | "en" | "es" | "fr" | "unknown", string> = {
  it: "⚠️ Si è verificato un errore, riprova tra poco.",
  en: "⚠️ Something went wrong, please try again shortly.",
  es: "⚠️ Se ha producido un error, inténtalo de nuevo en un momento.",
  fr: "⚠️ Une erreur s'est produite, réessaie dans un instant.",
  unknown: "⚠️ Something went wrong, please try again shortly.",
};

// M-ACP-1: a turn that completes but emits zero text chunks would
// otherwise send nothing at all — indistinguishable from a dead bridge.
const TURN_EMPTY: Record<"it" | "en" | "es" | "fr" | "unknown", string> = {
  it: "🤔 Non ho prodotto una risposta. Riprova o riformula la richiesta.",
  en: "🤔 I didn't produce a reply. Try again or rephrase.",
  es: "🤔 No he generado una respuesta. Inténtalo de nuevo o reformula.",
  fr: "🤔 Je n'ai pas produit de réponse. Réessaie ou reformule.",
  unknown: "🤔 I didn't produce a reply. Try again or rephrase.",
};

/**
 * Picks the polite-refusal copy matching the language detected in
 * `text`. Exported so the CLI (M7) uses the same source of truth as
 * the Discord adapter / test-injection ingress.
 */
export function pickRefusalMessage(text: string): string {
  return REFUSAL[detectLanguage(text)];
}

/** M-ACP-1: localized "the turn failed" copy (see TURN_ERROR). */
export function pickErrorMessage(text: string): string {
  return TURN_ERROR[detectLanguage(text)];
}

/** M-ACP-1: localized "the turn produced nothing" copy (see TURN_EMPTY). */
export function pickEmptyMessage(text: string): string {
  return TURN_EMPTY[detectLanguage(text)];
}

// M-LEGAL-1 — AI Act Art. 50 transparency (deadline 2026-08-02): the
// employee must be told, at the latest on first interaction, that they
// are talking to an AI system — with a pointer to the privacy notice.
const DISCLOSURE: Record<"it" | "en" | "es" | "fr" | "unknown", string> = {
  it: "ℹ️ Stai interagendo con un assistente AI (un sistema automatizzato), non con una persona.",
  en: "ℹ️ You are interacting with an AI assistant (an automated system), not a human.",
  es: "ℹ️ Estás interactuando con un asistente de IA (un sistema automatizado), no con una persona.",
  fr: "ℹ️ Tu interagis avec un assistant IA (un système automatisé), pas avec une personne.",
  unknown: "ℹ️ You are interacting with an AI assistant (an automated system), not a human.",
};

const DISCLOSURE_PRIVACY: Record<"it" | "en" | "es" | "fr" | "unknown", string> = {
  it: "Informativa privacy:",
  en: "Privacy notice:",
  es: "Aviso de privacidad:",
  fr: "Notice de confidentialité :",
  unknown: "Privacy notice:",
};

/** M-LEGAL-1: localized first-contact AI disclosure (+ optional link). */
export function pickDisclosureMessage(text: string, privacyNoticeUrl?: string): string {
  const lang = detectLanguage(text);
  const base = DISCLOSURE[lang];
  return privacyNoticeUrl ? `${base} ${DISCLOSURE_PRIVACY[lang]} ${privacyNoticeUrl}` : base;
}

export class Dispatcher {
  constructor(private deps: DispatcherDeps) {}

  /**
   * SCHED-2 — post a plain, deterministic message to the agent's
   * channel WITHOUT running a model turn (e.g. the scheduled-message
   * heads-up "🕐 È scattato un messaggio programmato…"). Uses the same
   * send target the reply pipeline uses.
   */
  async sendSystemMessage(agentId: string, userId: string, text: string): Promise<void> {
    const send = this.deps.resolveSendTarget(agentId, userId);
    await send(text);
  }

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

    // M-LEGAL-1: one-time AI-transparency disclosure on first contact.
    // Keyed on the in-memory turn-meta state (checked BEFORE prefix()
    // records this turn): a bridge restart re-discloses, which is
    // harmless over-disclosure — silence would be the violation.
    if (!this.deps.turnMeta.hasSeen(agentId, userId)) {
      await send(pickDisclosureMessage(text, this.deps.config.privacy_notice_url)).catch((err) =>
        logger.error({ err, agentId, userId }, "failed to deliver AI-disclosure message"),
      );
    }

    const queue = new SendQueue({ send });
    const buffer = new StreamBuffer({
      onFlush: (chunk) => queue.enqueue(chunk),
    });

    const prefix = this.deps.turnMeta.prefix(agentId, userId, text);
    const promptText = prefix + text;

    logger.info({ agentId, userId, textLen: text.length }, "dispatching to session manager");

    // M-ACP-1: track whether the turn emitted anything and whether it
    // failed, so we can surface a user-facing message instead of silence.
    let produced = false;
    let failed = false;
    try {
      await this.deps.sessionManager.prompt(agentId, userId, promptText, (update) => {
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          produced = true;
          buffer.push(update.content.text);
        }
      });
    } catch (err) {
      failed = true;
      logger.error({ err, agentId, userId }, "agent turn failed");
    } finally {
      buffer.end();
      await queue.drain();
    }

    // After any partial output has been flushed, tell the user what
    // happened. Errors are best-effort: if even this send throws, the
    // adapter's own catch logs it (no rethrow from here).
    if (failed) {
      await send(pickErrorMessage(text)).catch((sendErr) =>
        logger.error({ err: sendErr, agentId, userId }, "failed to deliver turn-error message"),
      );
    } else if (!produced) {
      await send(pickEmptyMessage(text)).catch((sendErr) =>
        logger.error({ err: sendErr, agentId, userId }, "failed to deliver empty-reply message"),
      );
    }
  }
}

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

// M-ACP-2 — dedicated copy for the 402/overquota chain: the credit
// gate raises BudgetExceededError → the LLM call fails → opencode
// errors the turn. Without classification the employee got the generic
// "something went wrong" and retried forever.
const TURN_NO_CREDITS: Record<"it" | "en" | "es" | "fr" | "unknown", string> = {
  it: "🪫 I crediti dell'organizzazione sono esauriti — avvisa il tuo amministratore (può ricaricarli dal pannello).",
  en: "🪫 Your organisation's credits are exhausted — tell your admin (they can top up from the panel).",
  es: "🪫 Los créditos de la organización se han agotado — avisa a tu administrador (puede recargarlos desde el panel).",
  fr: "🪫 Les crédits de l'organisation sont épuisés — préviens ton administrateur (il peut recharger depuis le panneau).",
  unknown: "🪫 Your organisation's credits are exhausted — tell your admin (they can top up from the panel).",
};

/** M-ACP-2: localized "no credits left" copy (see TURN_NO_CREDITS). */
export function pickNoCreditsMessage(text: string): string {
  return TURN_NO_CREDITS[detectLanguage(text)];
}

/**
 * M-ACP-2 — recognise the credit-gate abort in a failed turn's error
 * chain. The signatures come from litellm/hooks/cerase_credit_gate.py
 * ("cerase credit gate: …") and LiteLLM's BudgetExceededError; the raw
 * text survives into the ACP error message opencode reports.
 */
export function isCreditExhaustedError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message}` : String(err);
  return /cerase credit gate|BudgetExceeded|credits? exhausted/i.test(text);
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
    let creditExhausted = false;
    try {
      await this.deps.sessionManager.prompt(agentId, userId, promptText, (update) => {
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          produced = true;
          buffer.push(update.content.text);
        }
      });
    } catch (err) {
      failed = true;
      creditExhausted = isCreditExhaustedError(err);
      logger.error({ err, agentId, userId, creditExhausted }, "agent turn failed");
    } finally {
      buffer.end();
      await queue.drain();
    }

    // After any partial output has been flushed, tell the user what
    // happened. Errors are best-effort: if even this send throws, the
    // adapter's own catch logs it (no rethrow from here).
    if (failed) {
      const copy = creditExhausted ? pickNoCreditsMessage(text) : pickErrorMessage(text);
      await send(copy).catch((sendErr) =>
        logger.error({ err: sendErr, agentId, userId }, "failed to deliver turn-error message"),
      );
    } else if (!produced) {
      await send(pickEmptyMessage(text)).catch((sendErr) =>
        logger.error({ err: sendErr, agentId, userId }, "failed to deliver empty-reply message"),
      );
    }
  }
}

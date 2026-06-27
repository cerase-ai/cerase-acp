// Core message-handling pipeline. Receives (agentId, userId, text) from
// whichever ingress is active (Discord adapter, test-injection HTTP
// endpoint) and orchestrates allowlist → session-manager → stream-
// buffer → send-queue. Knows nothing about Discord — that's what
// `resolveSendTarget` is for.

import { isAllowed } from "./allowlist.js";
import type { DeliveryResult } from "./chat-adapter.js";
import type { BridgeConfig } from "./config.js";
import { makeLogger } from "./logger.js";
import { type DrainResult, SendQueue } from "./send-queue.js";
import type { SessionManager } from "./session-manager.js";
import { StreamBuffer } from "./stream-buffer.js";
import { detectLanguage, type TurnMetaTracker } from "./turn-meta.js";

const logger = makeLogger("cerase-acp.dispatcher");

// M-ACP-FAILLOUD-1: the send target now reports delivery success/failure
// instead of `Promise<void>`, so a swallowed channel error can surface.
type SendTarget = (chunk: string) => Promise<DeliveryResult>;

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
   *
   * M-ACP-FAILLOUD-1: returns the delivery outcome so the caller (the inject
   * endpoint) can report a truthful status instead of a blind 202.
   */
  async sendSystemMessage(agentId: string, userId: string, text: string): Promise<DeliveryResult> {
    const send = this.deps.resolveSendTarget(agentId, userId);
    return send(text);
  }

  /**
   * M-ACP-FAILLOUD-1 — `ok` iff the turn did NOT fail AND every delivery
   * succeeded. A turn failure = `prompt()` threw (the existing `failed` flag);
   * a delivery failure = the SendQueue lost a chunk after its retry, or a
   * direct send (refusal / error-copy / empty-copy) ultimately failed. Every
   * pre-existing behaviour (localized error/empty copy, credit-exhausted copy,
   * allowlist refusal, the delivery-failure marker) is preserved.
   */
  async handleMessage(agentId: string, userId: string, text: string): Promise<DeliveryResult> {
    // Allowlist gate. isAllowed throws on unknown agent id — let that
    // propagate so the adapter logs it as a wiring bug.
    if (!isAllowed(this.deps.config, agentId, userId)) {
      logger.info({ agentId, userId }, "rejected DM: user not in allowlist");
      const send = this.deps.resolveSendTarget(agentId, userId);
      // The refusal is the whole response — its delivery outcome IS the result.
      return this.safeSend(send, pickRefusalMessage(text), agentId, userId, "refusal message");
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
    let turnError: Error | undefined;
    // M-ACP-FAILLOUD-1: the streamed-reply delivery outcome (from the queue).
    let drainResult: DrainResult = { ok: true };
    try {
      await this.deps.sessionManager.prompt(agentId, userId, promptText, (update) => {
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          produced = true;
          buffer.push(update.content.text);
        }
      });
    } catch (err) {
      failed = true;
      turnError = err instanceof Error ? err : new Error(String(err));
      creditExhausted = isCreditExhaustedError(err);
      logger.error({ err, agentId, userId, creditExhausted }, "agent turn failed");
    } finally {
      buffer.end();
      drainResult = await queue.drain();
    }

    // After any partial output has been flushed, tell the user what
    // happened. Best-effort: a failure here is logged + folded into the
    // delivery outcome, never rethrown.
    let deliveryOk = drainResult.ok;
    if (failed) {
      const copy = creditExhausted ? pickNoCreditsMessage(text) : pickErrorMessage(text);
      const r = await this.safeSend(send, copy, agentId, userId, "turn-error message");
      if (!r.ok) deliveryOk = false;
    } else if (!produced) {
      const r = await this.safeSend(send, pickEmptyMessage(text), agentId, userId, "empty-reply message");
      if (!r.ok) deliveryOk = false;
    }

    // M-ACP-FAILLOUD-1: fail loud. A failed turn always yields `{ ok: false }`
    // (with the turn's own error); otherwise a swallowed delivery failure does.
    if (failed) {
      return { ok: false, error: turnError ?? new Error("agent turn failed") };
    }
    if (!deliveryOk) {
      return { ok: false, error: this.deliveryError(drainResult) };
    }
    return { ok: true };
  }

  /**
   * M-ACP-FAILLOUD-1 — deliver a single best-effort message and report the
   * outcome. A `!ok` result is logged; a send that still throws is caught and
   * converted to a `!ok` result so it never escapes handleMessage.
   */
  private async safeSend(
    send: SendTarget,
    text: string,
    agentId: string,
    userId: string,
    what: string,
  ): Promise<DeliveryResult> {
    try {
      const r = await send(text);
      if (!r.ok) {
        logger.error({ err: r.error, agentId, userId }, `failed to deliver ${what}`);
      }
      return r;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error({ err: error, agentId, userId }, `failed to deliver ${what}`);
      return { ok: false, error };
    }
  }

  /** Reduce a drain outcome to a single representative Error for the result. */
  private deliveryError(drainResult: DrainResult): Error {
    if (!drainResult.ok && drainResult.failures.length > 0) {
      const first = drainResult.failures[0]!;
      return new Error(`delivery failed for ${drainResult.failures.length} chunk(s): ${first.error.message}`);
    }
    return new Error("delivery failed");
  }
}

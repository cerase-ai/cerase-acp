// Core message-handling pipeline. Receives (agentId, userId, text) from
// whichever ingress is active (Discord adapter, test-injection HTTP
// endpoint) and orchestrates allowlist → session-manager → stream-
// buffer → send-queue. Knows nothing about Discord — that's what
// `resolveSendTarget` is for.

import { isAllowed } from "./allowlist.js";
import {
  type AttachFailure,
  type AttachOutcomeTracker,
  attachFailureError,
  attachFailurePrompt,
} from "./attach-outcome.js";
import type { DeliveryResult } from "./chat-adapter.js";
import type { BridgeConfig } from "./config.js";
import { isInternalSummaryBlock, summaryHeadingStart } from "./egress-redaction.js";
import { makeLogger } from "./logger.js";
import { deliveryFailureNotice } from "./platform-notices.js";
import { type DrainResult, SendQueue } from "./send-queue.js";
import { type SessionManager, type SessionUpdateHandler, TurnWatchdogError } from "./session-manager.js";
import { StreamBuffer } from "./stream-buffer.js";
import { detectLanguage, type SupportedLang, type TurnMetaTracker } from "./turn-meta.js";

const logger = makeLogger("cerase-acp.dispatcher");

// The send target reports delivery success/failure instead of
// `Promise<void>`, so a swallowed channel error can surface.
type SendTarget = (chunk: string) => Promise<DeliveryResult>;

export interface DispatcherDeps {
  config: BridgeConfig;
  sessionManager: SessionManager;
  turnMeta: TurnMetaTracker;
  /** Returns the function the bridge will call to deliver each chunk. */
  resolveSendTarget: (agentId: string, userId: string) => SendTarget;
  /**
   * Proactive out-of-credits gate. Called BEFORE the
   * ACP child is spawned / `prompt()` is invoked. Resolves `{exhausted:
   * true}` when the tenant is below the credit safety buffer (the
   * control-plane's 402), `{exhausted: false}` otherwise. Optional so the
   * CLI/test ingresses stay back-compatible; a bridge that can't reach the
   * control-plane MUST fail open (throw here → the dispatcher proceeds),
   * because blocking chat on a control-plane glitch is worse than the rare
   * overspend the reactive catch below still covers.
   */
  creditCheck?: (agentId: string) => Promise<{ exhausted: boolean }>;
  /**
   * The organization's wall clock and the pair's last turn, from the side that
   * persists both. Optional for the same reason `creditCheck` is: the CLI and
   * test ingresses have no control-plane, and a turn is worth more than a
   * clock. When it is absent or throws, the turn goes out with the block this
   * process has always produced.
   */
  turnContext?: (agentId: string, userId: string) => Promise<{ clock?: string; lastTurnAt?: number }>;
  /**
   * Where the send path records a file that did not reach the person. Optional
   * for the same reason the two above are: the CLI and test ingresses have no
   * attach path at all. When it is absent a turn closes exactly as it always
   * did — when it is wired, a failed upload denies the turn its success.
   */
  attachOutcomes?: AttachOutcomeTracker;
  /**
   * Receives an internal summary this dispatcher withheld from the chat, so it
   * can be kept rather than lost: the bridge posts it to the control-plane as
   * the assistant's rolling summary, the same capture its send path makes for
   * a summary it withholds there. Optional for the same reason as the three
   * above: the CLI and test ingresses have nowhere to keep it.
   */
  onSummaryWithheld?: (agentId: string, summary: string) => void;
}

const REFUSAL: Record<"it" | "en" | "es" | "fr" | "unknown", string> = {
  it: "Non sono ancora autorizzato a parlare con te — chiedi al tuo amministratore.",
  en: "I'm not authorised to talk to you yet — ask your admin.",
  es: "Aún no tengo permiso para hablar contigo — pídeselo a tu administrador.",
  fr: "Je n'ai pas encore le droit de te parler — demande à ton administrateur.",
  unknown: "I'm not authorised to talk to you yet — ask your admin.",
};

// A turn that throws (opencode crash, ACP rejection, gateway
// abort) must not leave the user staring at 👀 + a stopped typing
// indicator. Localized so non-Italian users aren't replied to in mixed
// language (same detectLanguage source as the refusal copy).
const TURN_ERROR: Record<"it" | "en" | "es" | "fr" | "unknown", string> = {
  it: "Si è verificato un errore, riprova tra poco.",
  en: "Something went wrong, please try again shortly.",
  es: "Se ha producido un error, inténtalo de nuevo en un momento.",
  fr: "Une erreur s'est produite, réessaie dans un instant.",
  unknown: "Something went wrong, please try again shortly.",
};

// A turn that completes but emits zero text chunks would
// otherwise send nothing at all — indistinguishable from a dead bridge.
const TURN_EMPTY: Record<"it" | "en" | "es" | "fr" | "unknown", string> = {
  it: "Non ho prodotto una risposta. Riprova o riformula la richiesta.",
  en: "I didn't produce a reply. Try again or rephrase.",
  es: "No he generado una respuesta. Inténtalo de nuevo o reformula.",
  fr: "Je n'ai pas produit de réponse. Réessaie ou reformule.",
  unknown: "I didn't produce a reply. Try again or rephrase.",
};

/**
 * Picks the polite-refusal copy matching the language detected in
 * `text`. Exported so the CLI (M7) uses the same source of truth as
 * the Discord adapter / test-injection ingress.
 */
export function pickRefusalMessage(text: string): string {
  return REFUSAL[detectLanguage(text)];
}

/** Localized "the turn failed" copy (see TURN_ERROR). */
export function pickErrorMessage(text: string): string {
  return TURN_ERROR[detectLanguage(text)];
}

/** Localized "the turn produced nothing" copy (see TURN_EMPTY). */
export function pickEmptyMessage(text: string): string {
  return TURN_EMPTY[detectLanguage(text)];
}

// Dedicated copy for the 402/overquota chain: the credit
// gate raises BudgetExceededError → the LLM call fails → opencode
// errors the turn. Without classification the employee got the generic
// "something went wrong" and retried forever.
const TURN_NO_CREDITS: Record<"it" | "en" | "es" | "fr" | "unknown", string> = {
  it: "I crediti dell'organizzazione sono esauriti — avvisa il tuo amministratore (può ricaricarli dal pannello).",
  en: "Your organisation's credits are exhausted — tell your admin (they can top up from the panel).",
  es: "Los créditos de la organización se han agotado — avisa a tu administrador (puede recargarlos desde el panel).",
  fr: "Les crédits de l'organisation sont épuisés — préviens ton administrateur (il peut recharger depuis le panneau).",
  unknown: "Your organisation's credits are exhausted — tell your admin (they can top up from the panel).",
};

/** Localized "no credits left" copy (see TURN_NO_CREDITS). */
export function pickNoCreditsMessage(text: string): string {
  return TURN_NO_CREDITS[detectLanguage(text)];
}

// Dedicated copy for a turn the watchdog ended at its CEILING: the child was
// alive and streaming the whole time and simply ran past the configured limit.
// The generic "something went wrong" invites an immediate retry of the same
// request, which is the one thing that reproduces it — so this names what
// happened and asks for a smaller piece of work.
const TURN_TOO_LONG: Record<"it" | "en" | "es" | "fr" | "unknown", string> = {
  it: "Ci stavo lavorando ma ho superato il tempo massimo per una singola richiesta. Prova a spezzarla in due, oppure chiedimi la parte che ti serve per prima.",
  en: "I was working on it but went past the maximum time for a single request. Try splitting it in two, or ask me for the part you need first.",
  es: "Estaba trabajando en ello pero he superado el tiempo máximo para una sola petición. Prueba a dividirla en dos, o pídeme antes la parte que necesitas.",
  fr: "J'y travaillais mais j'ai dépassé le temps maximum pour une seule demande. Essaie de la couper en deux, ou demande-moi d'abord la partie qu'il te faut.",
  unknown:
    "I was working on it but went past the maximum time for a single request. Try splitting it in two, or ask me for the part you need first.",
};

/** Localized "this turn ran past its ceiling" copy (see TURN_TOO_LONG). */
export function pickTooLongMessage(text: string): string {
  return TURN_TOO_LONG[detectLanguage(text)];
}

/**
 * Recognise the turn the watchdog ended for passing its ceiling, as opposed to
 * the one it killed for going silent. The class is the real test; the message
 * is checked too because a queue or an adapter between here and the manager may
 * hand the error on wrapped, and the whole point of this branch is that the
 * user is told what happened rather than given the generic failure.
 */
export function isTurnCeilingError(err: unknown): boolean {
  if (err instanceof TurnWatchdogError) return err.reason === "ceiling";
  const text = err instanceof Error ? err.message : String(err);
  return /turn watchdog: the turn was still running/i.test(text);
}

/**
 * Recognise the credit-gate abort in a failed turn's error
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
   * Returns the delivery outcome so the caller (the inject
   * endpoint) can report a truthful status instead of a blind 202.
   */
  /**
   * The language a notice the bridge writes by itself is in. The message's own
   * detection first; on a message too short to say («vedi contatti?»), the
   * last language this person wrote in; before anybody has, the organisation's.
   * English only when none of the three answers.
   */
  private noticeLang(agentId: string, userId: string, text: string): SupportedLang {
    const detected = detectLanguage(text);
    if (detected !== "unknown") return detected;
    const last = this.deps.turnMeta.languageFor(agentId, userId);
    if (last !== "unknown") return last;
    return this.deps.config.locale ?? "unknown";
  }

  async sendSystemMessage(agentId: string, userId: string, text: string): Promise<DeliveryResult> {
    const send = this.deps.resolveSendTarget(agentId, userId);
    return send(text);
  }

  /**
   * `ok` iff the turn did NOT fail AND every delivery
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
      return this.safeSend(send, REFUSAL[this.noticeLang(agentId, userId, text)], agentId, userId, "refusal message");
    }

    const send = this.deps.resolveSendTarget(agentId, userId);

    // Proactive out-of-credits gate, before spawning the ACP child / calling
    // prompt(). opencode swallows the LiteLLM 429/402, so the reactive catch
    // (below) never fires on exhaustion — the turn hangs until the watchdog.
    // Check first: if the tenant is out, reply the no-credits copy and
    // return without starting a turn. The reply is the whole response, so
    // its delivery outcome is the result.
    //
    // Fail-open: no dep (back-compat) → proceed; a check that THROWS
    // (control-plane unreachable) → log + proceed. A bridge that can't reach
    // the control-plane must never block chat; the reactive catch stays as a
    // belt for the rare overspend window.
    if (this.deps.creditCheck) {
      try {
        const { exhausted } = await this.deps.creditCheck(agentId);
        if (exhausted) {
          logger.info({ agentId, userId }, "credit gate: tenant exhausted — replying no-credits, not spawning");
          return this.safeSend(
            send,
            TURN_NO_CREDITS[this.noticeLang(agentId, userId, text)],
            agentId,
            userId,
            "no-credits message",
          );
        }
      } catch (err) {
        logger.warn({ err, agentId, userId }, "credit gate: pre-check failed — proceeding (fail-open)");
      }
    }

    const queue = new SendQueue({ send, failureMarker: deliveryFailureNotice(this.noticeLang(agentId, userId, text)) });
    const reply = this.replyStream(queue, agentId, userId);

    // One call, two facts, and neither is worth failing a turn over. The
    // resolver inside is consulted only when this process has no memory of the
    // pair, so a running bridge pays nothing per turn -- it is the restart that
    // used to tell somebody they had never spoken.
    let clock: string | undefined;
    let contextLastTurnAt: number | undefined;
    if (this.deps.turnContext) {
      try {
        const ctx = await this.deps.turnContext(agentId, userId);
        clock = ctx.clock;
        contextLastTurnAt = ctx.lastTurnAt;
      } catch (err) {
        logger.warn({ err, agentId, userId }, "turn context unavailable — proceeding without a clock");
      }
    }
    const prefix = await this.deps.turnMeta.prefixWithContext(agentId, userId, text, {
      clock,
      resolveLastTurn: contextLastTurnAt === undefined ? undefined : async () => contextLastTurnAt,
    });
    const promptText = prefix + text;

    logger.info({ agentId, userId, textLen: text.length }, "dispatching to session manager");

    // Track whether the turn emitted anything and whether it
    // failed, so we can surface a user-facing message instead of silence.
    let produced = false;
    let failed = false;
    let creditExhausted = false;
    let turnError: Error | undefined;
    // The streamed-reply delivery outcome (from the queue).
    let drainResult: DrainResult = { ok: true };
    // A turn owns the attach outcomes recorded while it streams and nothing an
    // earlier one left behind.
    this.deps.attachOutcomes?.begin(agentId, userId);
    try {
      await this.deps.sessionManager.prompt(agentId, userId, promptText, (update) => {
        if (reply.push(update)) produced = true;
      });
    } catch (err) {
      failed = true;
      turnError = err instanceof Error ? err : new Error(String(err));
      creditExhausted = isCreditExhaustedError(err);
      logger.error({ err, agentId, userId, creditExhausted }, "agent turn failed");
    } finally {
      // A failed or aborted turn ends here too, so text held back in it is
      // judged the same way and either delivered or withheld, never dropped
      // unread and never carried into the next turn.
      reply.end();
      drainResult = await queue.drain();
    }
    // Read once, here, whatever the turn did: an outcome left in the tracker
    // is an outcome the next turn would inherit.
    const attachFailures = this.deps.attachOutcomes?.take(agentId, userId) ?? [];

    // After any partial output has been flushed, tell the user what
    // happened. Best-effort: a failure here is logged + folded into the
    // delivery outcome, never rethrown.
    let deliveryOk = drainResult.ok;
    if (failed) {
      const lang = this.noticeLang(agentId, userId, text);
      const copy = creditExhausted
        ? TURN_NO_CREDITS[lang]
        : isTurnCeilingError(turnError)
          ? TURN_TOO_LONG[lang]
          : TURN_ERROR[lang];
      const r = await this.safeSend(send, copy, agentId, userId, "turn-error message");
      if (!r.ok) deliveryOk = false;
    } else if (!produced) {
      const r = await this.safeSend(
        send,
        TURN_EMPTY[this.noticeLang(agentId, userId, text)],
        agentId,
        userId,
        "empty-reply message",
      );
      if (!r.ok) deliveryOk = false;
    }

    // Fail loud. A failed turn always yields `{ ok: false }`
    // (with the turn's own error); otherwise a swallowed delivery failure does.
    if (failed) {
      return { ok: false, error: turnError ?? new Error("agent turn failed") };
    }
    // A file the person never received cannot close as a delivered turn. The
    // assistant wrote its closing sentence before the upload was attempted, so
    // it is told here what actually happened and given the turn's last word —
    // and the result is a failure whatever it then writes, because the outcome
    // must not depend on a second model call going well.
    if (attachFailures.length > 0) {
      await this.correctAttachClaim(agentId, userId, send, text, attachFailures);
      return { ok: false, error: attachFailureError(attachFailures) };
    }
    if (!deliveryOk) {
      return { ok: false, error: this.deliveryError(drainResult) };
    }
    return { ok: true };
  }

  /**
   * Tell the assistant what did not arrive, on the same session and before the
   * person writes again, and put its correction in the chat.
   *
   * Best-effort by design: a correction that itself fails is logged and the
   * turn is already a failure. An attach the correction asks for is drained
   * rather than acted on — this is the one place the loop could close on
   * itself.
   */
  private async correctAttachClaim(
    agentId: string,
    userId: string,
    send: SendTarget,
    text: string,
    failures: AttachFailure[],
  ): Promise<void> {
    const queue = new SendQueue({ send, failureMarker: deliveryFailureNotice(this.noticeLang(agentId, userId, text)) });
    const reply = this.replyStream(queue, agentId, userId);
    try {
      await this.deps.sessionManager.prompt(agentId, userId, attachFailurePrompt(failures), (update) => {
        reply.push(update);
      });
    } catch (err) {
      logger.error({ err, agentId, userId, failures }, "attach: the correction turn itself failed");
    } finally {
      reply.end();
      await queue.drain();
      this.deps.attachOutcomes?.take(agentId, userId);
    }
  }

  /**
   * The path one turn's reply takes from the ACP stream to the send queue.
   *
   * Text goes to the queue in pieces as it streams, and every piece meets the
   * egress filters on its own. That holds for every filter but one. An internal
   * summary is recognised by its section headings taken together, three of
   * them, and a summary that streams INSIDE a turn — opencode compacting on
   * overflow, the compaction agent's text arriving as ordinary message chunks —
   * is flushed in pieces that each carry fewer. Every piece passes, and so the
   * whole block reaches the chat.
   *
   * So the first of those headings starts a hold: the heading line and
   * everything after it are kept, and judged whole when the hold ends —
   * withheld if together they are a summary, delivered through the queue as
   * usual if not. Text before the heading is sent as it would have been, and a
   * reply with no such heading streams exactly as it did.
   *
   * The hold ends with the turn, or earlier when the agent starts a new
   * message. The second case is the one the compaction produces: opencode then
   * continues the same turn and answers the person in a new assistant message,
   * and judging that answer together with the summary before it would withhold
   * both. An agent that sends no message ids gets the first case only.
   *
   * `push` answers whether the update carried reply text.
   */
  private replyStream(
    queue: SendQueue,
    agentId: string,
    userId: string,
  ): { push: (update: Parameters<SessionUpdateHandler>[0]) => boolean; end: () => void } {
    const buffer = new StreamBuffer({
      onFlush: (chunk) => queue.enqueue(chunk),
      holdFrom: summaryHeadingStart,
      onHeld: (held) => {
        if (!isInternalSummaryBlock(held)) {
          queue.enqueue(held);
          return;
        }
        logger.warn(
          { agentId, userId, chars: held.length },
          "egress: suppressed an internal engine summary/compaction block",
        );
        try {
          this.deps.onSummaryWithheld?.(agentId, held);
        } catch (err) {
          logger.warn({ err, agentId }, "capturing a withheld summary failed — ignored");
        }
      },
    });
    let messageId: string | undefined;
    return {
      push: (update) => {
        if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return false;
        const next = (update as { messageId?: string }).messageId;
        if (next && messageId && next !== messageId) buffer.release();
        if (next) messageId = next;
        buffer.push(update.content.text);
        return true;
      },
      end: () => buffer.end(),
    };
  }

  /**
   * Deliver a single best-effort message and report the
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

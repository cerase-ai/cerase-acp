// Core message-handling pipeline. Receives (agentId, userId, text) from
// every ingress (each channel adapter, /internal/inject, the test-injection
// endpoint, the replay of messages kept across a stop) and orchestrates
// allowlist → credit check → turn_meta → session-manager → stream-buffer →
// send-queue. Knows no channel: `resolveSendTarget` and
// `resolveNoticeTarget` deliver.

import { isAllowed } from "./allowlist.js";
import {
  type AttachFailure,
  type AttachOutcomeTracker,
  attachFailureError,
  attachFailurePrompt,
} from "./attach-outcome.js";
import type { DeliveryResult, WholeAnswers } from "./chat-adapter.js";
import type { BridgeConfig } from "./config.js";
import { isInternalSummaryBlock, summaryHeadingStart } from "./egress-redaction.js";
import { EMPTY_TURN_RETRIES, emptyTurnRetryPrompt } from "./empty-turn.js";
import { makeLogger } from "./logger.js";
import type { PendingMessages } from "./pending-messages.js";
import { noticeText, type PlatformNotice } from "./platform-notice.js";
import {
  deliveryFailureNotice,
  keptMessagesExpiredNotice,
  restartOutlastedNotice,
  startedOverNotice,
  updateInterruptedNotice,
} from "./platform-notices.js";
import { RESTART_HOLD_MS, RESTART_RETRY_MS } from "./restart-hold.js";
import { type DrainResult, SendQueue } from "./send-queue.js";
import {
  BridgeStoppingError,
  type PromptOptions,
  type SessionManager,
  SessionOutgrownError,
  SessionRestartError,
  type SessionUpdateHandler,
  TurnWatchdogError,
} from "./session-manager.js";
import { type LastSummary, startedOverNote } from "./session-summary.js";
import { StreamBuffer } from "./stream-buffer.js";
import {
  fenceOpenAfter,
  toolCallMarkupHoldStart,
  toolCallMarkupRetryPrompt,
  withheldMarkupStart,
} from "./tool-call-markup.js";
import { detectLanguage, type SupportedLang, type TurnMetaTracker } from "./turn-meta.js";

const logger = makeLogger("cerase-acp.dispatcher");

// The send target reports delivery success/failure instead of
// `Promise<void>`, so a swallowed channel error can surface.
type SendTarget = (chunk: string) => Promise<DeliveryResult>;

type NoticeTarget = (notice: PlatformNotice) => Promise<DeliveryResult>;

export interface DispatcherDeps {
  config: BridgeConfig;
  sessionManager: SessionManager;
  turnMeta: TurnMetaTracker;
  /** Returns the function the bridge will call to deliver each chunk. */
  resolveSendTarget: (agentId: string, userId: string) => SendTarget;
  /**
   * The function that sends a platform notice in the agent's channel's own box,
   * or undefined when its adapter draws none. Optional: the test-injection
   * dispatcher has no channel, and an absent or undefined target sends the
   * notice spelled out through `resolveSendTarget`.
   */
  resolveNoticeTarget?: (agentId: string, userId: string) => NoticeTarget | undefined;
  /**
   * Proactive out-of-credits gate. Called BEFORE the
   * ACP child is spawned / `prompt()` is invoked. Resolves `{exhausted:
   * true}` when the tenant is below the credit safety buffer (the
   * control-plane's 402), `{exhausted: false}` otherwise. Optional because
   * the test-injection dispatcher has no control-plane; a bridge that can't reach the
   * control-plane MUST fail open (throw here → the dispatcher proceeds),
   * because blocking chat on a control-plane glitch is worse than the rare
   * overspend the reactive catch below still covers.
   */
  creditCheck?: (agentId: string) => Promise<{ exhausted: boolean }>;
  /**
   * The organization's wall clock and the pair's last turn, from the side that
   * persists both. Optional for the same reason `creditCheck` is: the
   * test-injection dispatcher has no control-plane, and a turn is worth more
   * than a clock. When it is absent or throws, the turn_meta block carries no
   * clock and its gap comes from this process's memory alone.
   */
  turnContext?: (agentId: string, userId: string) => Promise<{ clock?: string; lastTurnAt?: number }>;
  /**
   * Where the send path records a file that did not reach the person.
   * Optional: the test-injection dispatcher has no attach path. When it is
   * wired, a failed upload denies the turn its success.
   */
  attachOutcomes?: AttachOutcomeTracker;
  /**
   * Receives an internal summary this dispatcher withheld from the chat, so it
   * can be kept rather than lost: the bridge posts it to the control-plane as
   * the assistant's rolling summary, the same capture its send path makes for
   * a summary it withholds there. Optional for the same reason as the three
   * above: the test-injection dispatcher has nowhere to keep it.
   */
  onSummaryWithheld?: (agentId: string, summary: string) => void;
  /**
   * The assistant's last rolling summary, from the side that stores it. Read
   * when a session grew past what the runtime can summarise, to start the one
   * replacing it. Optional for the same reason as the others; absent, or
   * throwing, the new session starts without it.
   */
  lastSummary?: (agentId: string) => Promise<LastSummary | undefined>;
  /**
   * The agent's channel, when it takes each answer as one message: see
   * `ChatAdapter.wholeAnswers`. Absent, or answering undefined, a reply goes
   * out in pieces as it streams, which is what Discord, Telegram, Slack, web
   * and the test-injection dispatcher get.
   */
  wholeAnswers?: (agentId: string) => WholeAnswers | undefined;
  /**
   * How long a turn that lost its session to a restart waits for it, and how
   * often it tries again. Only tests pass it; the bridge runs on the measured
   * RESTART_HOLD_MS and RESTART_RETRY_MS.
   */
  restartHold?: { boundMs: number; retryMs: number };
  /**
   * Where a message that arrives while the bridge is stopping is kept for the
   * next bridge to answer. Optional for the same reason as the others: the
   * test-injection dispatcher never hands a message on. Absent, or failing to
   * keep one, the person is told to send it again.
   */
  pendingMessages?: PendingMessages;
}

/**
 * How long a stopping bridge waits for the turns in flight to end. A turn
 * that ends within it is answered in full; one still running at the end is
 * interrupted and the person told so. The release that recreates the bridge
 * waits this long at most, and the container must be given longer than this
 * and STOP_NOTICE_MS together to stop, or it is killed before the notices go
 * out. The bridge reads CERASE_ACP_STOP_DRAIN_MS in its place, for tests.
 */
export const STOP_DRAIN_MS = 180_000;

/**
 * How long a stopping bridge waits, once it has ended the sessions of the
 * turns still running, for those turns to tell their person. Each first asks
 * whether the slot restarted, two looks at the container a second apart with
 * up to five seconds each, and then sends one message.
 */
export const STOP_NOTICE_MS = 20_000;

/** What a stopping bridge did with the turns in flight, for its log. */
export interface StopReport {
  /** Turns running when the bridge started to stop. */
  turnsAtStop: number;
  /** How long it waited for them, in ms. */
  waitedMs: number;
  /** Turns still running at the limit, ended with the notice. */
  turnsInterrupted: number;
  /** Turns still running once the notices had their time. */
  turnsUnfinished: number;
  /** Messages kept for the next bridge to answer. */
  messagesKept: number;
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

// A turn that ended with no text and no tool call, tried again three times
// (see empty-turn.ts) and still without an answer. The model is not failing:
// it keeps ending on its reasoning, so the person is told it is taking longer,
// not that something broke.
const TURN_SLOW: Record<"it" | "en" | "es" | "fr" | "unknown", string> = {
  it: "Ci sto mettendo più del previsto a risponderti. Riprova tra qualche minuto.",
  en: "This is taking me longer than expected. Please try again in a few minutes.",
  es: "Me está llevando más tiempo de lo previsto responderte. Inténtalo de nuevo en unos minutos.",
  fr: "Cela me prend plus de temps que prévu pour te répondre. Réessaie dans quelques minutes.",
  unknown: "This is taking me longer than expected. Please try again in a few minutes.",
};

// A turn whose answer came out as a tool call written as text, twice: the
// first was held back and the assistant was given one more try, and the second
// was held back too. The person has been sent nothing that answers them, and
// the one thing that can still help is asking again.
const TURN_UNSENT: Record<"it" | "en" | "es" | "fr" | "unknown", string> = {
  it: "La risposta non mi è uscita in modo corretto e non te l'ho mandata. Chiedimelo di nuovo, per favore.",
  en: "My answer did not come out right, so I did not send it. Please ask me again.",
  es: "Mi respuesta no ha salido bien y no te la he enviado. Pídemelo de nuevo, por favor.",
  fr: "Ma réponse n'est pas sortie correctement et je ne te l'ai pas envoyée. Redemande-moi, s'il te plaît.",
  unknown: "My answer did not come out right, so I did not send it. Please ask me again.",
};

/**
 * Picks the polite-refusal copy matching the language detected in
 * `text`. Exported for the refusals sent outside the dispatcher: the CLI's
 * and the Workspace Chat listener's.
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

/** Localized "this is taking longer" copy (see TURN_SLOW). */
export function pickSlowMessage(text: string): string {
  return TURN_SLOW[detectLanguage(text)];
}

// The copy for a turn refused for lack of credits: the control-plane's credit
// check answered 402 before the turn, or the turn failed on the LiteLLM credit
// gate's error (isCreditExhaustedError). The generic failure copy would invite
// a retry that cannot succeed.
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

/** A turn being held through a restart: see `Dispatcher.promptThroughRestarts`. */
interface RestartHold {
  /** Settles when the turns of this conversation held before this one are done. */
  before: Promise<void>;
  /** Whether another turn of this conversation was being held when this one started. */
  afterAnother: boolean;
  heldAt: number;
  deadline: number;
  retryMs: number;
  end: () => void;
}

/** One prompt's reply on its way from the ACP stream to the send queue: see `Dispatcher.replyStream`. */
interface ReplyStream {
  push: (update: Parameters<SessionUpdateHandler>[0]) => boolean;
  end: () => void;
  /** Drop whatever is held and not yet queued, and take nothing more. */
  discard: () => void;
  endedInMarkup: () => boolean;
}

export class Dispatcher {
  // Per conversation, the end of the turns being held through a restart. A
  // turn held after another waits for it, and a message that arrives meanwhile
  // waits for both, so the assistant answers them in the order they were sent.
  private holds = new Map<string, Promise<void>>();

  // Per conversation, the end of the last turn that has taken its place: see
  // `turnInOrder`. Every turn waits for the one before it to end, follow-ups
  // included.
  private inOrder = new Map<string, Promise<void>>();

  // Per conversation, the turns `handleMessage` is running now, whoever sent
  // them: an adapter, a scheduled message, a platform note.
  private running = new Map<string, Set<Promise<DeliveryResult>>>();

  // Set when the bridge starts to stop. From then on a message is kept for the
  // next bridge rather than sent to the assistant.
  private stopping = false;
  // Set when the stop has waited as long as it waits. A turn that fails from
  // then on was cut off by the stop, and its person is told that.
  private interrupting = false;
  private kept = 0;

  constructor(private deps: DispatcherDeps) {}

  /**
   * Settles when every turn of this conversation that is running now has
   * ended, whether it worked or not; null when none is running. A platform
   * note that arrives during a turn waits on this to join the notes that
   * arrive with it (see note-coalescer.ts).
   */
  turnsRunning(agentId: string, userId: string): Promise<void> | null {
    const turns = this.running.get(`${agentId}:${userId}`);
    if (!turns || turns.size === 0) return null;
    return Promise.allSettled([...turns]).then(() => undefined);
  }

  /** Whether the bridge has started to stop: see `stop`. */
  isStopping(): boolean {
    return this.stopping;
  }

  /**
   * Stop taking turns, for a bridge that is going away.
   *
   * From the call on, a message is kept for the next bridge instead of being
   * sent to the assistant. So is every message received earlier whose prompt
   * has not been sent yet: one whose session is still starting, one queued
   * behind a turn of its conversation, one held through a slot restart. The
   * turns the assistant is already working on go on, for up to `limitMs`. The
   * ones still running then are cut off: their sessions are ended through
   * `endSessions`, and each tells its person that an update interrupted the
   * answer. Such a turn is not kept, because the assistant may already have
   * acted on it; only a message the assistant never saw is answered again.
   */
  async stop(opts: { limitMs: number; noticeMs: number; endSessions: () => Promise<void> }): Promise<StopReport> {
    this.stopping = true;
    this.deps.sessionManager.stopStartingTurns();
    const startedAt = Date.now();
    const turnsAtStop = this.turnsInFlight().length;
    logger.info(
      { turnsInFlight: turnsAtStop, limitMs: opts.limitMs },
      "the bridge is stopping — waiting for the turns in flight to end; a message arriving meanwhile is kept for the next bridge",
    );
    let still = await this.turnsEnd(opts.limitMs);
    const waitedMs = Date.now() - startedAt;
    const turnsInterrupted = still;
    if (still > 0) {
      this.interrupting = true;
      logger.warn(
        { turnsInterrupted: still, waitedMs },
        "turns still running at the limit — ending their sessions and telling each person an update interrupted the answer",
      );
      await opts.endSessions();
      still = await this.turnsEnd(opts.noticeMs);
    }
    const report: StopReport = {
      turnsAtStop,
      waitedMs,
      turnsInterrupted,
      turnsUnfinished: still,
      messagesKept: this.kept,
    };
    logger.info(report, "the bridge has stopped taking turns");
    return report;
  }

  private turnsInFlight(): Promise<DeliveryResult>[] {
    return [...this.running.values()].flatMap((turns) => [...turns]);
  }

  /**
   * Settles when no turn is running, or after `ms`, with how many still are.
   * A turn that starts meanwhile is waited for too; while stopping, every one
   * that does is a message being kept, which takes no time.
   */
  private async turnsEnd(ms: number): Promise<number> {
    const deadline = Date.now() + ms;
    for (;;) {
      const turns = this.turnsInFlight();
      const left = deadline - Date.now();
      if (turns.length === 0 || left <= 0) return turns.length;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(turns),
        new Promise((resolve) => {
          timer = setTimeout(resolve, left);
        }),
      ]);
      clearTimeout(timer);
    }
  }

  /**
   * Keep a message the assistant has not seen for the next bridge, and report
   * it delivered: the adapter acknowledged it on arrival as it does every
   * message, and the answer comes from the next bridge. A message that cannot
   * be kept is answered with the notice a message gets when the assistant is
   * restarting, which asks the person to send it again.
   */
  private async keepForNextBridge(
    agentId: string,
    userId: string,
    text: string,
    receivedAt: number,
  ): Promise<DeliveryResult> {
    const kept = this.deps.pendingMessages?.keep({ agentId, userId, text, receivedAt });
    if (kept) {
      this.kept += 1;
      logger.info(
        { agentId, userId, textLen: text.length },
        "the bridge is stopping — message kept for the next bridge to answer",
      );
      return { ok: true };
    }
    logger.error(
      { agentId, userId, textLen: text.length },
      "the bridge is stopping and the message could not be kept — telling the person to send it again",
    );
    const r = await this.safeSend(
      this.deps.resolveSendTarget(agentId, userId),
      restartOutlastedNotice(this.noticeLang(agentId, userId, text)),
      agentId,
      userId,
      "message-not-kept notice",
    );
    return r.ok ? { ok: false, error: new Error("the bridge was stopping and the message could not be kept") } : r;
  }

  private trackTurn(agentId: string, userId: string, turn: Promise<DeliveryResult>): void {
    const key = `${agentId}:${userId}`;
    let turns = this.running.get(key);
    if (!turns) {
      turns = new Set();
      this.running.set(key, turns);
    }
    const set = turns;
    set.add(turn);
    const forget = () => {
      set.delete(turn);
      if (set.size === 0 && this.running.get(key) === set) this.running.delete(key);
    };
    turn.then(forget, forget);
  }

  /**
   * The language a notice the bridge writes by itself is in. The message's own
   * detection first; on a message too short to say («vedi contatti?»), the
   * last language this person wrote in; before anybody has, the organisation's.
   * When none of the three answers it is "unknown", which this file's own copy
   * writes in English and platform-notices.ts in Italian.
   */
  private noticeLang(agentId: string, userId: string, text: string): SupportedLang {
    const detected = detectLanguage(text);
    if (detected !== "unknown") return detected;
    const last = this.deps.turnMeta.languageFor(agentId, userId);
    if (last !== "unknown") return last;
    return this.deps.config.locale ?? "unknown";
  }

  /**
   * Tell a person that the messages kept for them across a restart are too
   * old to be answered now, in the assistant's voice and the language they
   * wrote them in. No turn runs: the assistant never sees them.
   */
  tellKeptMessagesExpired(agentId: string, userId: string, texts: string[]): Promise<DeliveryResult> {
    return this.safeSend(
      this.deps.resolveSendTarget(agentId, userId),
      keptMessagesExpiredNotice(this.noticeLang(agentId, userId, texts.join("\n")), texts.length),
      agentId,
      userId,
      "kept-messages-expired notice",
    );
  }

  /**
   * Post a plain, deterministic message to the agent's channel without
   * running a model turn (e.g. the scheduled-message heads-up). Uses the same
   * send target the reply pipeline uses, and returns the delivery outcome so
   * the inject endpoint can answer 500 when it fails.
   */
  async sendSystemMessage(agentId: string, userId: string, text: string): Promise<DeliveryResult> {
    const send = this.deps.resolveSendTarget(agentId, userId);
    return send(text);
  }

  /**
   * A notice from the platform, in the channel's own box where the adapter
   * draws one and spelled out, address included, where it does not. No model
   * turn: the assistant did not write it and must not answer it.
   */
  async sendNotice(agentId: string, userId: string, notice: PlatformNotice): Promise<DeliveryResult> {
    const target = this.deps.resolveNoticeTarget?.(agentId, userId);
    if (target) return target(notice);
    return this.sendSystemMessage(agentId, userId, noticeText(notice));
  }

  /**
   * Run one message and report it. `ok` iff the turn did not fail, every
   * delivery succeeded, every file the reply carried reached the person, and
   * the answer was not held back as tool-call markup twice. A turn failure is
   * `prompt()` throwing; a delivery failure is a chunk the SendQueue lost
   * after its retries, or a direct send (refusal, notice, error copy) that
   * failed.
   */
  handleMessage(agentId: string, userId: string, text: string, receivedAt = Date.now()): Promise<DeliveryResult> {
    const turn = this.runTurn(agentId, userId, text, receivedAt);
    this.trackTurn(agentId, userId, turn);
    return turn;
  }

  private async runTurn(agentId: string, userId: string, text: string, receivedAt: number): Promise<DeliveryResult> {
    // Allowlist gate. isAllowed throws on unknown agent id — let that
    // propagate so the adapter logs it as a wiring bug.
    if (!isAllowed(this.deps.config, agentId, userId)) {
      logger.info({ agentId, userId }, "rejected DM: user not in allowlist");
      const send = this.deps.resolveSendTarget(agentId, userId);
      // The refusal is the whole response — its delivery outcome IS the result.
      return this.safeSend(send, REFUSAL[this.noticeLang(agentId, userId, text)], agentId, userId, "refusal message");
    }

    // Before anything is asked of the control-plane, and before the send
    // target is made: the next bridge does both for this message.
    if (this.stopping) return this.keepForNextBridge(agentId, userId, text, receivedAt);

    const send = this.deps.resolveSendTarget(agentId, userId);

    // Proactive out-of-credits gate, before spawning the ACP child / calling
    // prompt(). opencode swallows the LiteLLM 429/402, so the reactive catch
    // (below) never fires on exhaustion — the turn hangs until the watchdog.
    // Check first: if the tenant is out, reply the no-credits copy and
    // return without starting a turn. The reply is the whole response, so
    // its delivery outcome is the result.
    //
    // Fail-open: no dep → proceed; a check that THROWS
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

    // One turn of a conversation at a time, from its first prompt to its last
    // follow-up. A message the person sends while the assistant is answering
    // waits here, not in the session's queue: a follow-up the bridge sends
    // after the turn's prompt ended (another try after an empty answer or a
    // held-back one, the correction of a file that did not arrive) is part of
    // the same turn, and on 6 October one queued behind the person's «??» left
    // them reading nothing while the answer to their earlier message waited.
    const release = await this.turnInOrder(agentId, userId);
    try {
      // A bridge that began to stop while this message waited keeps it for
      // the next one: the assistant has not seen it.
      if (this.stopping) return await this.keepForNextBridge(agentId, userId, text, receivedAt);
      return await this.answer(agentId, userId, text, receivedAt, send);
    } finally {
      release();
    }
  }

  /**
   * Wait for every turn of this conversation that came before this one, and
   * hold the place of this one until the returned function is called. While it
   * waits the turn is in no queue of the session manager, so it is counted for
   * the agent as a held turn is.
   */
  private async turnInOrder(agentId: string, userId: string): Promise<() => void> {
    const key = `${agentId}:${userId}`;
    const before = this.inOrder.get(key);
    let done: () => void = () => {};
    const mine = new Promise<void>((resolve) => {
      done = resolve;
    });
    const tail = (before ?? Promise.resolve()).then(() => mine);
    this.inOrder.set(key, tail);
    const release = () => {
      done();
      if (this.inOrder.get(key) === tail) this.inOrder.delete(key);
    };
    if (before) {
      const sm = this.deps.sessionManager;
      const waiting = typeof sm.holdTurn === "function" ? sm.holdTurn(agentId) : () => {};
      try {
        await before;
      } finally {
        waiting();
      }
    }
    return release;
  }

  /** The turn itself, once every earlier turn of its conversation has ended: see `runTurn`. */
  private async answer(
    agentId: string,
    userId: string,
    text: string,
    receivedAt: number,
    send: SendTarget,
  ): Promise<DeliveryResult> {
    // Behind any turn of this conversation still waiting out a restart.
    await this.holds.get(`${agentId}:${userId}`);

    let { queue, reply } = this.openReply(agentId, userId, send, text);

    // One call, two facts, and neither is worth failing a turn over. The clock
    // goes into every turn_meta block; the last turn's time is used only when
    // this process has no memory of the pair, as after a restart.
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

    // Track whether the turn answered the person and whether it failed, so
    // we can surface a user-facing message instead of silence. Text that was
    // withheld whole answers nobody: see `spoke`.
    let produced = false;
    // Whether the turn started a tool. A turn with neither text nor a tool
    // call ended on its reasoning alone, and is tried again below.
    let acted = false;
    let failed = false;
    let creditExhausted = false;
    let restartOutlasted = false;
    // The turn never reached the assistant because the bridge started to stop.
    let keep = false;
    let turnError: Error | undefined;
    // The streamed-reply delivery outcome (from the queue).
    let drainResult: DrainResult = { ok: true };
    // The delivery of the notice saying the conversation started over, when it did.
    let startedOver: DeliveryResult = { ok: true };
    // A turn owns the attach outcomes recorded while it streams and nothing an
    // earlier one left behind.
    this.deps.attachOutcomes?.begin(agentId, userId);
    const onUpdate: SessionUpdateHandler = (update) => {
      if (update.sessionUpdate === "tool_call") acted = true;
      if (reply.push(update)) produced = true;
    };
    // A try that ended without its answer, cut off by a restart or refused by
    // a session that outgrew its summary. What it already sent stays sent;
    // what it held back is dropped, because the next try answers in full.
    const cut = async () => {
      reply.discard();
      const drained = await queue.drain();
      if (!drained.ok) drainResult = drained;
      produced = false;
      ({ queue, reply } = this.openReply(agentId, userId, send, text));
    };
    try {
      try {
        await this.promptThroughRestarts(agentId, userId, promptText, onUpdate, cut, { opensTurn: true });
      } catch (err) {
        if (!(err instanceof SessionOutgrownError)) throw err;
        // The session grew past what the runtime can summarise, and the
        // session manager has let it go. The message is sent once more, to a
        // new session that starts from the last summary, after the person is
        // told. Any failure of that try is the turn's failure: it is never
        // sent a third time. Until it is queued again the turn is in no
        // queue, so the agent counts it here, as it does a held turn.
        const waiting = this.deps.sessionManager.holdTurn(agentId);
        let note: string;
        try {
          await cut();
          const fresh = await this.startOver(agentId, userId, send, text);
          startedOver = fresh.delivery;
          note = fresh.note;
        } finally {
          waiting();
        }
        await this.promptThroughRestarts(agentId, userId, promptText, onUpdate, cut, { context: note });
      }
    } catch (err) {
      if (err instanceof BridgeStoppingError) {
        keep = true;
      } else {
        failed = true;
        turnError = err instanceof Error ? err : new Error(String(err));
        creditExhausted = isCreditExhaustedError(err);
        restartOutlasted = err instanceof SessionRestartError;
        logger.error({ err, agentId, userId, creditExhausted }, "agent turn failed");
      }
    } finally {
      // A failed or aborted turn ends here too, so text held back in it is
      // judged the same way and either delivered or withheld, never dropped
      // unread and never carried into the next turn.
      reply.end();
      const last = await queue.drain();
      if (drainResult.ok) drainResult = last;
      produced = produced && this.spoke(queue, last, reply);
    }
    if (keep) {
      this.deps.attachOutcomes?.take(agentId, userId);
      return this.keepForNextBridge(agentId, userId, text, receivedAt);
    }
    // A turn that ended with no text and no tool call is asked again at once,
    // on the same session, with a note telling the assistant to answer. Nothing
    // is sent to the person between tries, so the typing indicator the adapter
    // holds for the turn stays on; only a fourth empty answer reaches them.
    let emptyTries = 0;
    while (!failed && !produced && !acted && emptyTries < EMPTY_TURN_RETRIES && !this.stopping) {
      emptyTries += 1;
      logger.warn(
        { agentId, userId, attempt: emptyTries, of: EMPTY_TURN_RETRIES },
        "the turn ended with no text and no tool call — asking the assistant again",
      );
      ({ queue, reply } = this.openReply(agentId, userId, send, text));
      try {
        await this.deps.sessionManager.prompt(agentId, userId, emptyTurnRetryPrompt(), onUpdate);
      } catch (err) {
        failed = true;
        turnError = err instanceof Error ? err : new Error(String(err));
        creditExhausted = isCreditExhaustedError(err);
        restartOutlasted = err instanceof SessionRestartError;
        logger.error({ err, agentId, userId, creditExhausted }, "the try after an empty turn failed");
      } finally {
        reply.end();
        const drained = await queue.drain();
        if (drainResult.ok) drainResult = drained;
        produced = produced && this.spoke(queue, drained, reply);
      }
    }
    // An answer that ended as a tool call written out as text was held back,
    // not sent. The assistant gets one more try on the same session; when that
    // one ends the same way the person is told, because nothing they were sent
    // answers them.
    let answerUnsent = false;
    let retryDrain: DrainResult = { ok: true };
    if (!failed && reply.endedInMarkup()) {
      const retry = await this.retryUnsentAnswer(agentId, userId, send, text);
      retryDrain = retry.drain;
      answerUnsent = !retry.answered;
    }
    // Read once, here, whatever the turn did: an outcome left in the tracker
    // is an outcome the next turn would inherit.
    const attachFailures = this.deps.attachOutcomes?.take(agentId, userId) ?? [];

    // After any partial output has been flushed, tell the user what
    // happened. Best-effort: a failure here is logged + folded into the
    // delivery outcome, never rethrown.
    let deliveryOk = drainResult.ok && retryDrain.ok && startedOver.ok;
    if (failed) {
      const lang = this.noticeLang(agentId, userId, text);
      const copy = this.interrupting
        ? updateInterruptedNotice(lang)
        : creditExhausted
          ? TURN_NO_CREDITS[lang]
          : restartOutlasted
            ? restartOutlastedNotice(lang)
            : isTurnCeilingError(turnError)
              ? TURN_TOO_LONG[lang]
              : TURN_ERROR[lang];
      const r = await this.safeSend(send, copy, agentId, userId, "turn-error message");
      if (!r.ok) deliveryOk = false;
    } else if (answerUnsent) {
      // The one more try a stop cut off did not fail for the reason it was
      // asked for, and the person is told what did happen.
      const lang = this.noticeLang(agentId, userId, text);
      const r = await this.safeSend(
        send,
        this.interrupting ? updateInterruptedNotice(lang) : TURN_UNSENT[lang],
        agentId,
        userId,
        "unsent-answer message",
      );
      if (!r.ok) deliveryOk = false;
    } else if (!produced) {
      // A turn that ran a tool and wrote nothing did something, and is not
      // asked again; one that did neither was, and every try came back empty.
      const lang = this.noticeLang(agentId, userId, text);
      const r = await this.safeSend(
        send,
        acted ? TURN_EMPTY[lang] : TURN_SLOW[lang],
        agentId,
        userId,
        acted ? "empty-reply message" : "taking-longer message",
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
    if (answerUnsent) {
      return { ok: false, error: new Error("the answer came out as tool-call markup twice and was not sent") };
    }
    if (!deliveryOk) {
      if (!startedOver.ok && drainResult.ok && retryDrain.ok) return startedOver;
      return { ok: false, error: this.deliveryError(drainResult.ok ? retryDrain : drainResult) };
    }
    return { ok: true };
  }

  /**
   * Tell the person their conversation is starting over, and build what the
   * new session is told ahead of their message: the assistant's last summary,
   * or that there is none. A summary that cannot be read is logged and the
   * conversation starts over without it.
   */
  private async startOver(
    agentId: string,
    userId: string,
    send: SendTarget,
    text: string,
  ): Promise<{ note: string; delivery: DeliveryResult }> {
    let summary: LastSummary | undefined;
    if (this.deps.lastSummary) {
      try {
        summary = await this.deps.lastSummary(agentId);
      } catch (err) {
        logger.warn({ err, agentId, userId }, "the last summary could not be read — the new session starts without it");
      }
    }
    logger.warn(
      { agentId, userId, fromSummary: summary !== undefined },
      "the conversation outgrew its summary — sending the message again to a new session",
    );
    const delivery = await this.safeSend(
      send,
      startedOverNotice(this.noticeLang(agentId, userId, text), summary !== undefined),
      agentId,
      userId,
      "started-over notice",
    );
    return { note: startedOverNote(summary), delivery };
  }

  /**
   * Send a turn, and when it loses its session to a restart, hold it and send
   * it again until the session is back or the bound has passed.
   *
   * Every try sends the person's message as it came. When the restart cut the
   * assistant off after it had started, opencode already stored that message,
   * and the resumed session holds it twice; what the assistant did before the
   * restart is in the session too, between the two.
   *
   * `onCut` runs after each try a restart cut off, before the next one. Any
   * other failure, on any try, is the turn's failure. Past
   * the bound the last SessionRestartError is thrown, which the caller tells
   * the person about in words of its own. `options` go with every try.
   */
  private async promptThroughRestarts(
    agentId: string,
    userId: string,
    promptText: string,
    onUpdate: SessionUpdateHandler,
    onCut: () => Promise<void>,
    options?: PromptOptions,
  ): Promise<void> {
    let hold: RestartHold | undefined;
    try {
      for (;;) {
        try {
          await this.deps.sessionManager.prompt(agentId, userId, promptText, onUpdate, options);
          if (hold) {
            logger.info(
              { agentId, userId, heldMs: Date.now() - hold.heldAt },
              "a turn held through a restart was sent",
            );
          }
          return;
        } catch (err) {
          // A session the stopping bridge ended is not coming back in this
          // process, and the turn is not one to keep: it had reached the
          // assistant. It fails here and its person is told why.
          if (!(err instanceof SessionRestartError) || this.interrupting) throw err;
          // Between tries the turn is in no queue, so the agent counts it here;
          // during a try the session manager counts it as any other.
          const waiting = this.deps.sessionManager.holdTurn(agentId);
          try {
            await onCut();
            if (!hold) {
              hold = this.beginHold(agentId, userId, err);
              await hold.before;
              // The turn held before this one got its session back or gave up;
              // either way this one tries now rather than a retry later.
              if (hold.afterAnother) continue;
            }
            const wait = Math.min(hold.retryMs, hold.deadline - Date.now());
            if (wait <= 0) {
              logger.error(
                { agentId, userId, heldMs: Date.now() - hold.heldAt },
                "the assistant's session did not come back within the bound — telling the person",
              );
              throw err;
            }
            await new Promise((r) => setTimeout(r, wait));
          } finally {
            waiting();
          }
        }
      }
    } finally {
      hold?.end();
    }
  }

  /**
   * Start holding a turn of this conversation: it goes after any turn of it
   * already held, and a message arriving before `end()` goes after it.
   */
  private beginHold(agentId: string, userId: string, lost: SessionRestartError): RestartHold {
    const key = `${agentId}:${userId}`;
    const earlier = this.holds.get(key);
    const before = earlier ?? Promise.resolve();
    let release: () => void = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = before.then(() => mine);
    this.holds.set(key, tail);
    const boundMs = this.deps.restartHold?.boundMs ?? RESTART_HOLD_MS;
    const heldAt = Date.now();
    logger.warn(
      { agentId, userId, reachedAgent: lost.reachedAgent, boundMs },
      "the assistant's session restarted under this turn — holding it until the session is back",
    );
    return {
      before,
      afterAnother: earlier !== undefined,
      heldAt,
      deadline: heldAt + boundMs,
      retryMs: this.deps.restartHold?.retryMs ?? RESTART_RETRY_MS,
      end: () => {
        release();
        if (this.holds.get(key) === tail) this.holds.delete(key);
      },
    };
  }

  /**
   * Give the assistant one more try after its answer came out as a tool call
   * written as text, on the same session, and report whether it answered this
   * time. Its reply takes the same path as any other, so a second answer of
   * the same kind is held back too; a retry that itself fails counts as no
   * answer. It is never retried again.
   */
  private async retryUnsentAnswer(
    agentId: string,
    userId: string,
    send: SendTarget,
    text: string,
  ): Promise<{ answered: boolean; drain: DrainResult }> {
    const { queue, reply } = this.openReply(agentId, userId, send, text);
    let failed = false;
    try {
      await this.deps.sessionManager.prompt(agentId, userId, toolCallMarkupRetryPrompt(), (update) => {
        reply.push(update);
      });
    } catch (err) {
      failed = true;
      logger.error({ err, agentId, userId }, "the retry after an answer written as tool-call markup failed");
    } finally {
      reply.end();
    }
    const drain = await queue.drain();
    const answered = !failed && !reply.endedInMarkup() && this.spoke(queue, drain, reply);
    if (!answered) {
      logger.warn({ agentId, userId }, "the retry did not produce an answer either — telling the person to ask again");
    }
    return { answered, drain };
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
    const { queue, reply } = this.openReply(agentId, userId, send, text);
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
   * The send queue and the reply stream for one prompt's answer, in the shape
   * the agent's channel takes it.
   */
  private openReply(
    agentId: string,
    userId: string,
    send: SendTarget,
    text: string,
  ): { queue: SendQueue; reply: ReplyStream } {
    const whole = this.deps.wholeAnswers?.(agentId);
    const queue = new SendQueue({
      send,
      failureMarker: deliveryFailureNotice(this.noticeLang(agentId, userId, text)),
      split: whole ? (answer) => whole.split(answer) : undefined,
    });
    return { queue, reply: this.replyStream(queue, agentId, userId, whole !== undefined) };
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
   * A line opening a tool-call block starts the same hold, for the same
   * reason: whether the block runs to the end of the message, and is therefore
   * an answer the model wrote as a call, is known only when the message ends.
   * The stream reports whether the turn ended on such a block, which is what
   * decides the retry.
   *
   * On a channel that takes each answer as one message (`whole`), nothing is
   * flushed as it streams. The text is judged by the same holds when the agent
   * starts a new message, starts a tool, or ends the turn, and what is
   * delivered goes to the queue in one piece only when a tool starts or the
   * turn ends. The text before a tool is therefore a message of its own, sent
   * as the tool starts: a tool can run for minutes, and the person reads what
   * the assistant is doing while it does, instead of finding it at the top of
   * the answer once the work it announces is over.
   *
   * `push` answers whether the update carried reply text.
   */
  private replyStream(queue: SendQueue, agentId: string, userId: string, whole: boolean): ReplyStream {
    // Whether what this message has sent so far leaves a code fence open. A
    // tool-call block inside a fence is quoted, not emitted, so no hold starts
    // there.
    let fenceOpen = false;
    // True while the last text of the turn is a tool-call block that was held
    // back; anything sent after it answers the person and clears it.
    let endedInMarkup = false;
    // On a whole-answer channel, what has been delivered of the answer and not
    // yet sent. Every cut inside one answer falls at the start of a line — the
    // heading or the tool-call block a hold starts at — or at the end of an
    // assistant message, and the buffer trims the whitespace at a cut; a blank
    // line is what puts back the break that was there.
    let answer: string[] = [];
    const sendAnswer = () => {
      if (answer.length === 0) return;
      queue.enqueue(answer.join("\n\n"));
      answer = [];
    };
    const deliver = (text: string) => {
      if (whole) answer.push(text);
      else queue.enqueue(text);
      fenceOpen = fenceOpenAfter(text, fenceOpen);
      endedInMarkup = false;
    };
    const buffer = new StreamBuffer({
      onFlush: deliver,
      wholeMessages: whole,
      holdFrom: (piece) => earliest(summaryHeadingStart(piece), toolCallMarkupHoldStart(piece, fenceOpen)),
      onHeld: (held) => {
        if (isInternalSummaryBlock(held)) {
          logger.warn(
            { agentId, userId, chars: held.length },
            "egress: suppressed an internal engine summary/compaction block",
          );
          try {
            this.deps.onSummaryWithheld?.(agentId, held);
          } catch (err) {
            logger.warn({ err, agentId }, "capturing a withheld summary failed — ignored");
          }
          return;
        }
        // Judged whole, from the first line that opens with a tag: when
        // everything from such a line to the end of the message is a tool call
        // written out, or tags with no words, it is held back, and the sentence
        // before it, when there is one, is sent as it would have been. Anything
        // else, a block followed by prose among it, is delivered unchanged.
        const markup = withheldMarkupStart(held, fenceOpen);
        if (markup) {
          const before = held.slice(0, markup.at).trimEnd();
          if (before.length > 0) deliver(before);
          logger.warn(
            { agentId, userId, chars: held.length - markup.at, kind: markup.kind },
            markup.kind === "call"
              ? "egress: held back an answer written as tool-call markup"
              : "egress: held back text made only of tags",
          );
          endedInMarkup = true;
          return;
        }
        deliver(held);
      },
    });
    let messageId: string | undefined;
    return {
      push: (update) => {
        if (whole && (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")) {
          buffer.flush();
          sendAnswer();
          return false;
        }
        if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return false;
        const next = (update as { messageId?: string }).messageId;
        if (next && messageId && next !== messageId) {
          // The message before ends here: nothing of it runs into this one.
          buffer.flush();
          buffer.release();
          fenceOpen = false;
        }
        if (next) messageId = next;
        buffer.push(update.content.text);
        return true;
      },
      end: () => {
        buffer.end();
        sendAnswer();
      },
      discard: () => {
        buffer.discard();
        answer = [];
      },
      endedInMarkup: () => endedInMarkup,
    };
  }

  /**
   * Whether a prompt's reply reached the person. A part of it delivered does,
   * and so does a part the channel refused, since the person is told; so does
   * an answer held back as tool-call markup, which has a retry of its own.
   * Text withheld whole, by the stream's holds or by the send path, reached
   * nobody, and a reply that was only that has not answered the person.
   */
  private spoke(queue: SendQueue, drained: DrainResult, reply: ReplyStream): boolean {
    return queue.delivered() > 0 || !drained.ok || reply.endedInMarkup();
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

/** The smaller of two indexes where -1 means none. */
function earliest(a: number, b: number): number {
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentConfig, BridgeConfig } from "./config.js";
import { makeLogger } from "./logger.js";
import {
  type CanonicalFetcher,
  type CompactionProbe,
  defaultEndpointForAgent,
  defaultFetcher,
  execCompactionProbe,
  execSummaryStateProbe,
  type RestEndpoint,
  type SummaryState,
  type SummaryStateProbe,
} from "./opencode-rest.js";
import { decidePermissionOutcome } from "./permission-policy.js";
import { PromptQueue } from "./prompt-queue.js";
import { reconcile, type SeenState } from "./reconciler.js";
import { dockerSlotRestartProbe, type SlotRestartProbe, slotContainerOf } from "./restart-hold.js";
import { ResumableSessions } from "./resumable-sessions.js";
import {
  decideSessionMode,
  type ModeAdvertisement,
  type SessionModeUnavailable,
  sessionModeUnavailableDetail,
} from "./session-mode.js";

const logger = makeLogger("cerase-acp.session-manager");

/**
 * Streaming session-update events the caller cares about. We forward the
 * raw ACP SessionUpdate union (agent_message_chunk, tool_call,
 * tool_call_update, plan, agent_thought_chunk, etc.), and each caller (the
 * dispatcher's reply stream, the CLI) picks the cases it needs.
 */
type SessionUpdate = acp.SessionNotification["update"];

export type SessionUpdateHandler = (update: SessionUpdate) => void;

/** Result of one `prompt()` round-trip. */
export interface PromptResult {
  stopReason: acp.PromptResponse["stopReason"];
}

/**
 * Per-turn telemetry captured by `prompt()`. Emitted both as a `pino`
 * info-level log line (`[turn_telemetry] …`) and via the optional
 * `onTelemetry` hook so operators / metrics layers can subscribe
 * without parsing log output.
 *
 * Used to dimension the upstream opencode race (#17505 / #25421) in
 * production: a `drainExit` of "ceiling", or a `lastChunkAgeMs` near
 * `POST_PROMPT_MAX_DRAIN_MS`, says the drain bound needs more room.
 */
export interface TurnTelemetry {
  agentId: string;
  userId: string;
  /** Total session/update notifications received during the turn. */
  chunksReceived: number;
  /** Subset of `chunksReceived` that were `agent_message_chunk`. */
  textChunks: number;
  /** Subset of `chunksReceived` that were `agent_thought_chunk`. */
  thoughtChunks: number;
  /** Why the drain loop exited: idle window / ceiling / child closed. */
  drainExit: "idle" | "ceiling" | "closed";
  /** Wall-clock ms from `connection.prompt()` call → its resolution. */
  promptToEndTurnMs: number;
  /** Wall-clock ms from end_turn → drain loop exit. */
  endTurnToDrainDoneMs: number;
  /**
   * Wall-clock ms between the last update received and drain exit.
   * Near 0 when a chunk landed right before exit; near
   * POST_PROMPT_IDLE_MS in the typical idle-exit case.
   */
  lastChunkAgeMs: number;
  /**
   * Length (`string.length`) of the `agent_message_chunk` text recovered
   * from opencode's REST API after the drain loop. `0` means the ACP stream
   * delivered everything; any other value is text the stream dropped and
   * the reconciliation replayed.
   */
  reconciledTextBytes: number;
  /** Same as above but for `agent_thought_chunk` (reasoning) text. */
  reconciledReasoningBytes: number;
}

export interface SessionManagerOptions {
  /** Subscribe to per-turn telemetry. Fires AFTER the drain loop. */
  onTelemetry?: (t: TurnTelemetry) => void;
  /**
   * Inject a canonical-message fetcher for the REST reconciliation after
   * each turn. Tests use this to substitute a canned reply;
   * production omits it and `defaultFetcher` (reads the opencode
   * serve REST endpoint from inside the slot) is used.
   */
  canonicalFetcher?: CanonicalFetcher;
  /**
   * Inject an endpoint resolver. Tests use a fake endpoint;
   * production passes the agent's container name (derived from
   * `spawn.args` in agents.yaml) to `defaultEndpointForAgent`.
   * Returning `null` disables reconciliation for that agent.
   */
  endpointResolver?: (containerName: string) => RestEndpoint | null;
  /**
   * Per-turn watchdog for a hung opencode child: the child is killed, the
   * turn rejects (the dispatcher sends the localized copy) and the next
   * prompt respawns.
   *
   * It measures silence, not elapsed time, because a wall clock cannot tell a
   * dead child from one that is working. Every update re-arms it, so a child
   * emitting thought chunks is never ended by it. It does not fire while a
   * tool call the turn opened is still running: a sub-agent started with the
   * `task` tool sends this session nothing until it returns, and then only
   * the ceiling applies. Nor does it fire while the session is writing the
   * summary of its history: see COMPACTION_SILENCE_MS.
   */
  turnSilenceMs?: number;
  /**
   * The ceiling a turn cannot cross even while it keeps streaming, for the
   * turn that never stops rather than for the one that is slow. Reaching it
   * rejects with `reason: "ceiling"`, which the dispatcher renders as a reply
   * saying the work ran past its limit — never as silence.
   */
  turnCeilingMs?: number;
  /**
   * Asked, when a session's connection closes under a turn the bridge did not
   * close itself, whether the agent's slot restarted. Tests pass one; the
   * default reads the slot container's state through the docker proxy.
   */
  slotRestarted?: SlotRestartProbe;
  /**
   * Where the session each pair is talking through is written, so a bridge
   * that restarts resumes it. The bridge passes its state directory; without
   * one the record lives in memory and survives slot restarts only.
   */
  stateDir?: string;
  /**
   * Asks which summary of its history a session is writing now: its message
   * id, or null. Tests pass one. Without it the slot's opencode server is
   * asked (execCompactionProbe), for an agent whose spawn is a `docker exec`
   * into a slot; an agent with no slot has nothing to ask, and its silent
   * turns end at the silence limit.
   */
  compactionProbe?: (agent: AgentConfig, sessionId: string) => Promise<string | null>;
  /**
   * Asks where a session stands with the summaries of its history before a
   * person's message is sent to it (see SummaryState); null when it could not
   * be read. Tests pass one. Without it the slot's opencode server is asked,
   * for an agent whose spawn is a `docker exec` into a slot.
   */
  summaryState?: (agent: AgentConfig, sessionId: string) => Promise<SummaryState | null>;
}

/**
 * What the bridge sends a session whose summary was left unfinished, before the
 * person's message: opencode's own command for a summary, which writes a marker
 * of its own and runs the summary under it, so the summary cuts and every
 * marker before it is done.
 */
export const SUMMARY_COMMAND = "/compact";

/** The session still held an unfinished summary after the bridge had it summarise again. */
export class SummaryNotSettledError extends Error {
  constructor(readonly sessionId: string) {
    super(
      `session ${sessionId} still holds an unfinished summary after it was asked to summarise again — the message was not sent, so it is not answered under a summary`,
    );
    this.name = "SummaryNotSettledError";
  }
}

/**
 * Why a turn was cut. `silent` is the hung child the watchdog has always been
 * for; `ceiling` is a turn that was alive the whole time and ran too long, and
 * the two want different copy in front of the user.
 */
export type TurnWatchdogReason = "silent" | "ceiling";

/** A turn the watchdog ended, carrying which of the two limits it hit. */
export class TurnWatchdogError extends Error {
  constructor(
    readonly reason: TurnWatchdogReason,
    readonly ms: number,
  ) {
    super(
      reason === "ceiling"
        ? `turn watchdog: the turn was still running after ${ms}ms, the configured ceiling — ended and respawning on next prompt`
        : `turn watchdog: opencode child produced nothing for ${ms}ms — killed and respawning on next prompt`,
    );
    this.name = "TurnWatchdogError";
  }
}

// How often the watchdog looks, at most. It compares two timestamps, so the
// cost is a closure every few seconds for the length of a turn.
//
// The tick is capped by the SMALLER of the two limits it is checking, because
// a resolution coarser than the limit is a limit that does not hold: a
// half-second silence budget checked every five seconds is a five-second one.
const WATCHDOG_TICK_MAX_MS = 5_000;
const watchdogTick = (...limitsMs: number[]) => Math.max(10, Math.min(WATCHDOG_TICK_MAX_MS, ...limitsMs));

/**
 * How long a turn may go without an update while its session is writing the
 * summary of its history, in place of the silence limit: the longest a summary
 * may take before its first word.
 *
 * opencode sends nothing over ACP while it summarises until the summary's text
 * streams, and the model reads the whole conversation before writing it. A
 * summary of a 149,367-token conversation has taken 354 s, twice the silence
 * limit. On a window of 256k tokens the part summarised can be about 1.7 times
 * that size, about ten minutes at the same pace; fifteen leave room above it
 * and stay under the turn's ceiling, which still applies.
 */
export const COMPACTION_SILENCE_MS = 15 * 60_000;

/**
 * How often a turn that has gone silent asks whether its session is writing
 * its summary. The first ask comes after this much silence, so the status line
 * says so within about this long of the summary's start, and a turn whose model
 * is only slow to answer costs one `docker exec` per interval.
 */
export const COMPACTION_PROBE_EVERY_MS = 10_000;

// How long the watchdog waits on an ask before it takes the session for one
// not summarising. The slot's own read gives up after 5 s.
const COMPACTION_PROBE_TIMEOUT_MS = 10_000;

/**
 * A turn that lost its session to a restart: the slot's container stopped or
 * restarted under it, or the bridge closed that session itself. The session
 * comes back on the next prompt, so the dispatcher holds the turn and sends it
 * again rather than telling the person it failed.
 *
 * `reachedAgent` says the assistant had started on the prompt — it had sent
 * at least one update — so opencode had already stored the person's message.
 */
export class SessionRestartError extends Error {
  constructor(
    readonly reachedAgent: boolean,
    readonly cause: unknown,
  ) {
    super(
      `the assistant's session restarted under this turn (${cause instanceof Error ? cause.message : String(cause)})`,
    );
    this.name = "SessionRestartError";
  }
}

/**
 * A turn the runtime refused because the session has grown past what it can
 * summarise. Every later turn of that session would be refused the same way,
 * so the session manager has already let it go: the next prompt for the pair
 * starts a new session instead of resuming this one.
 */
export class SessionOutgrownError extends Error {
  constructor(
    readonly sessionId: string,
    readonly cause: unknown,
  ) {
    super(
      `the assistant's session ${sessionId} is too large to summarise and was let go (${cause instanceof Error ? cause.message : String(cause)})`,
    );
    this.name = "SessionOutgrownError";
  }
}

/**
 * Whether a failed prompt is the runtime refusing to summarise a session.
 *
 * opencode 1.18.18 checks its compaction trigger after every model step. The
 * summary call carries the whole history in one message, and when that call
 * fails as too large the runtime ends the turn with a `ContextOverflowError`,
 * which its ACP layer sends as a JSON-RPC internal error: code -32603, message
 * `Internal error: Session too large to compact - context exceeds model limit
 * even after stripping media` (or `Conversation history too large to compact`
 * when it had already set the last message aside), data
 * `{ service: "session", errorName: "ContextOverflowError" }`.
 *
 * Both halves are required: the error name the runtime put in `data`, and the
 * words "too large to compact" in the message. Anything else, an overflow the
 * runtime reports for another reason included, fails the turn as any other
 * error does.
 */
export function isCompactionOverflow(err: unknown): boolean {
  if (!(err instanceof acp.RequestError)) return false;
  const data = err.data;
  const errorName = typeof data === "object" && data !== null ? (data as { errorName?: unknown }).errorName : undefined;
  return errorName === "ContextOverflowError" && /too large to compact/i.test(err.message);
}

/**
 * A turn refused before it reached the assistant because the bridge is
 * stopping. Nothing was sent, so the message can be kept and answered by the
 * next bridge without the assistant seeing it twice.
 */
export class BridgeStoppingError extends Error {
  constructor() {
    super("the bridge is stopping and starts no new turn");
    this.name = "BridgeStoppingError";
  }
}

/** What a prompt carries besides the person's text. */
export interface PromptOptions {
  /**
   * The prompt starts a turn: it carries a message to the assistant for the
   * first time. Once the bridge is stopping such a prompt is refused with
   * BridgeStoppingError before it reaches the assistant, also when it was
   * already waiting for its session to start or queued behind another turn of
   * the same conversation. A prompt that continues a turn already running
   * leaves it unset and is sent.
   */
  opensTurn?: boolean;
  /**
   * Text for the assistant alone, sent in the same prompt ahead of the
   * person's: a content block whose audience is the assistant, which opencode
   * stores as a synthetic part. The model reads it; the runtime's own views
   * leave it out of the person's message.
   */
  context?: string;
  /**
   * Told `true` when the session is found writing the summary of its history
   * during this prompt, and `false` once it no longer is: an update that
   * belongs to another message, the slot no longer finding the summary, or the
   * prompt's end. Each change is told once.
   */
  onCompaction?: (compacting: boolean) => void;
  /**
   * Told the text of a summary the bridge had the session write before this
   * prompt, because one was left unfinished: the same summary a turn's own
   * withheld one is, for the assistant's rolling summary.
   */
  onSummary?: (text: string) => void;
}

/**
 * A handshake whose child went away before it finished, with the moment the
 * child was spawned. Internal: `prompt()` turns it into a SessionRestartError
 * when the slot restarted, and into the handshake's own error when not.
 */
class SessionStartLost extends Error {
  constructor(
    readonly cause: unknown,
    readonly spawnedAt: number,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "SessionStartLost";
  }
}

/**
 * Optional injection point so tests can swap real `child_process.spawn`
 * for a custom spawner. Production code uses the default.
 */
export type SpawnFn = (command: string, args: string[]) => ChildProcess;

const defaultSpawn: SpawnFn = (command, args) => spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });

interface SessionEntry {
  agentId: string;
  userId: string;
  child: ChildProcess;
  connection: acp.ClientSideConnection;
  sessionId: string;
  queue: PromptQueue;
  lastTurnAt: number;
  idleTimer?: NodeJS.Timeout;
  /** Set when the current prompt() wants to receive sessionUpdate events. */
  onUpdate?: SessionUpdateHandler;
  /** Set true once the child has exited (cleanup is in progress). */
  closed: boolean;
  /** When the child was spawned: a slot that started after it outlived it. */
  spawnedAt: number;
  /**
   * Set when the bridge itself kills the child: idle, eviction, a reload, the
   * watchdog. A turn that then finds the connection closed lost it to the
   * bridge, which needs no probe to know.
   */
  closedByBridge: boolean;
  /**
   * Set when the session grew past what the runtime can summarise. Its id is
   * never kept for a resume, and a turn still queued on it is sent again to
   * the session that replaces it.
   */
  outgrown: boolean;
}

const sessionKey = (agentId: string, userId: string) => `${agentId}:${userId}`;

/**
 * The model a `session/new` or `session/load` response says the session is on:
 * the current value of its `model` config option, which opencode formats as
 * `providerID/modelID`. `undefined` when the response carries no such option.
 */
function currentModelOf(res: { configOptions?: unknown } | undefined): string | undefined {
  const options = res?.configOptions;
  if (!Array.isArray(options)) return undefined;
  for (const option of options) {
    if (typeof option !== "object" || option === null) continue;
    const { id, currentValue } = option as { id?: unknown; currentValue?: unknown };
    if (id !== "model") continue;
    return typeof currentValue === "string" && currentValue.length > 0 ? currentValue : undefined;
  }
  return undefined;
}

// How many sessions stay resumable. One short string per (agent,user) that has
// ever talked, so the map would otherwise grow for the life of the process and
// the file with it; the oldest are dropped first and the only cost of dropping
// one is that a very old conversation restarts cold.
const RESUMABLE_SESSIONS_MAX = 500;

/**
 * Owns the lifecycle of one ACP child per (agent, user) pair. Lazy-spawns
 * on first prompt; reuses on subsequent prompts; respawns transparently
 * after the child exits; kills idle children after the configured
 * timeout.
 */
export class SessionManager {
  private entries = new Map<string, SessionEntry>();
  // In-flight spawn promises, keyed by session key, so
  // concurrent first prompts share one spawn instead of double-spawning.
  private inFlightSpawns = new Map<string, Promise<SessionEntry>>();
  // The opencode session id each (agent,user) is talking through, recorded
  // when the session starts and kept AFTER its child dies. It is what makes a
  // restart survivable: the slot restarts for many ordinary reasons — a skill
  // install rewrites AGENTS.md and the entrypoint watcher SIGTERMs opencode,
  // the idle killer fires, the image is updated — and every one of them used
  // to start the next message from zero while the user saw no explanation.
  // opencode keeps the session in its own SQLite on a named volume, so the id
  // stays valid across the container's death; the state lives there, not
  // here. The record is written to the state directory as well, because the
  // bridge restarts too, and a bridge that is killed lets no child exit first.
  private resumableSessions: ResumableSessions;
  // Agents whose slot does not offer the mode they run under (`mode`, default
  // `cerase`), so no session for them can start. Kept here rather than in the caller because this is where the
  // absence is seen and where the recovery is seen too, and a report that
  // only ever gets set is a report that outlives the fault it names.
  private sessionModeFailures = new Map<string, SessionModeUnavailable>();
  private agentsById = new Map<string, AgentConfig>();
  private idleMs: number;
  // session.max_concurrent enforced as a real ceiling (LRU eviction).
  private maxConcurrent: number;
  private onTelemetry?: (t: TurnTelemetry) => void;
  private canonicalFetcher: CanonicalFetcher;
  private endpointResolver: (containerName: string) => RestEndpoint | null;
  private slotRestarted: SlotRestartProbe;
  // Turns the dispatcher is holding through a restart, per agent. They have no
  // session to sit in while they wait, and they are still outstanding.
  private heldTurns = new Map<string, number>();
  // Set when the bridge starts to stop: see PromptOptions.opensTurn.
  private stopping = false;

  constructor(
    private config: BridgeConfig,
    private spawnFn: SpawnFn = defaultSpawn,
    options?: SessionManagerOptions,
  ) {
    for (const a of config.agents) this.agentsById.set(a.id, a);
    this.idleMs = config.session.idle_timeout_minutes * 60 * 1000;
    this.maxConcurrent = config.session.max_concurrent;
    this.onTelemetry = options?.onTelemetry;
    this.canonicalFetcher = options?.canonicalFetcher ?? defaultFetcher;
    this.endpointResolver = options?.endpointResolver ?? defaultEndpointForAgent;
    this.slotRestarted = options?.slotRestarted ?? dockerSlotRestartProbe();
    this.resumableSessions = new ResumableSessions(options?.stateDir, RESUMABLE_SESSIONS_MAX);
    // The file's value, then the default, and options override both because
    // only tests pass them. A mail assistant and one carrying a project do not
    // want the same ceiling, which is why the file gets to say.
    this.silencePinned = options?.turnSilenceMs !== undefined;
    this.ceilingPinned = options?.turnCeilingMs !== undefined;
    this.turnSilenceMs = options?.turnSilenceMs ?? (config.session.turn_silence_seconds ?? 180) * 1000;
    this.turnCeilingMs = options?.turnCeilingMs ?? (config.session.turn_ceiling_minutes ?? 45) * 60 * 1000;
    this.compactionProbe = options?.compactionProbe;
    this.summaryState = options?.summaryState;
  }

  // See SessionManagerOptions.summaryState.
  private readonly summaryState?: (agent: AgentConfig, sessionId: string) => Promise<SummaryState | null>;
  private readonly slotSummaryState: SummaryStateProbe = execSummaryStateProbe();

  /** How this agent's sessions are read for an unfinished summary; undefined when they cannot be. */
  private summaryStateFor(agent: AgentConfig): ((sessionId: string) => Promise<SummaryState | null>) | undefined {
    const injected = this.summaryState;
    if (injected) return (sessionId) => injected(agent, sessionId);
    const container = slotContainerOf(agent.spawn);
    if (container === null) return undefined;
    return (sessionId) => this.slotSummaryState(container, sessionId);
  }

  /**
   * Before a person's message: a summary the session is writing is waited for,
   * and one left unfinished is written again under a marker of its own, so the
   * message is answered and never taken as the summary's parent.
   *
   * The read and the wait run in the session's queue, after the turns ahead of
   * this one; the summary is a prompt of its own, queued behind them too.
   */
  private async settleSummary(agent: AgentConfig, userId: string, entry: SessionEntry, options: PromptOptions) {
    const read = this.summaryStateFor(agent);
    if (!read) return;
    const readSafely = async (): Promise<SummaryState | null> => {
      try {
        return await read(entry.sessionId);
      } catch (err) {
        logger.warn(
          { agentId: agent.id, userId, reason: err instanceof Error ? err.message : String(err) },
          "could not read whether the session holds an unfinished summary — the message is sent as it is",
        );
        return null;
      }
    };
    const tell = (compacting: boolean) => {
      try {
        options.onCompaction?.(compacting);
      } catch (err) {
        logger.warn({ err, agentId: agent.id, userId }, "onCompaction threw — ignored");
      }
    };
    const state = await entry.queue.enqueue(async () => {
      let found = await readSafely();
      if (found?.kind !== "writing") return found;
      logger.info(
        { agentId: agent.id, userId, sessionId: entry.sessionId, summaryMessageId: found.messageId },
        "the session is writing a summary — the message waits for it",
      );
      tell(true);
      const until = Date.now() + COMPACTION_SILENCE_MS;
      try {
        while (found?.kind === "writing" && Date.now() < until) {
          await new Promise((r) => setTimeout(r, COMPACTION_PROBE_EVERY_MS));
          found = await readSafely();
        }
      } finally {
        tell(false);
      }
      if (found?.kind === "writing") {
        logger.error(
          { agentId: agent.id, userId, sessionId: entry.sessionId },
          "the session was still writing a summary after the wait — the message is sent as it is",
        );
        return null;
      }
      return found;
    });
    if (state?.kind !== "stranded") return;
    logger.warn(
      { agentId: agent.id, userId, sessionId: entry.sessionId, markerId: state.markerId },
      "the session holds a summary left unfinished — it summarises again before the message",
    );
    let summary = "";
    await this.prompt(
      agent.id,
      userId,
      SUMMARY_COMMAND,
      (update) => {
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          summary += update.content.text;
        }
      },
      { onCompaction: options.onCompaction },
    );
    const after = await entry.queue.enqueue(readSafely);
    if (after?.kind === "stranded" || after?.kind === "writing") throw new SummaryNotSettledError(entry.sessionId);
    if (summary.trim() !== "") {
      try {
        options.onSummary?.(summary);
      } catch (err) {
        logger.warn({ err, agentId: agent.id, userId }, "onSummary threw — ignored");
      }
    }
  }

  // See SessionManagerOptions.compactionProbe.
  private readonly compactionProbe?: (agent: AgentConfig, sessionId: string) => Promise<string | null>;
  private readonly slotCompactionProbe: CompactionProbe = execCompactionProbe();

  /** How this agent's sessions are asked whether they are summarising; undefined when they cannot be. */
  private compactionProbeFor(agent: AgentConfig): ((sessionId: string) => Promise<string | null>) | undefined {
    const injected = this.compactionProbe;
    if (injected) return (sessionId) => injected(agent, sessionId);
    const container = slotContainerOf(agent.spawn);
    if (container === null) return undefined;
    return (sessionId) => this.slotCompactionProbe(container, sessionId);
  }

  private turnSilenceMs: number;
  private turnCeilingMs: number;
  // A limit a caller passed explicitly is not the file's to change: only
  // tests pass one, and a reload must not undo the value a test pinned.
  private readonly silencePinned: boolean;
  private readonly ceilingPinned: boolean;

  /**
   * Take a reloaded `session` block without a restart.
   *
   * The control-plane rewrites agents.yaml and the bridge reloads it, but a
   * release that leaves the bridge image unchanged never recreates the
   * container, so a limit read only at boot is one a reload can never change:
   * a turn waiting on an approval longer than the boot-time silence limit is
   * killed before the approval can expire.
   *
   * The watchdog of a turn in flight reads these fields on every tick, so a
   * turn already waiting runs under the new limit from the next tick on.
   */
  applySession(session: BridgeConfig["session"]): void {
    this.config.session = session;
    this.idleMs = session.idle_timeout_minutes * 60 * 1000;
    this.maxConcurrent = session.max_concurrent;
    if (!this.silencePinned) this.turnSilenceMs = (session.turn_silence_seconds ?? 180) * 1000;
    if (!this.ceilingPinned) this.turnCeilingMs = (session.turn_ceiling_minutes ?? 45) * 60 * 1000;
  }

  /** The limits the running bridge enforces, as `agents.yaml` spells them. */
  sessionLimits(): {
    idle_timeout_minutes: number;
    max_concurrent: number;
    turn_silence_seconds: number;
    turn_ceiling_minutes: number;
  } {
    return {
      idle_timeout_minutes: this.idleMs / 60_000,
      max_concurrent: this.maxConcurrent,
      turn_silence_seconds: this.turnSilenceMs / 1000,
      turn_ceiling_minutes: this.turnCeilingMs / 60_000,
    };
  }

  activeSessionCount(): number {
    return this.entries.size;
  }

  /**
   * Refuse every prompt that would start a turn from now on, while the turns
   * already running go on. Called once, when the bridge starts to stop.
   */
  stopStartingTurns(): void {
    this.stopping = true;
  }

  /**
   * How many turns this agent has outstanding right now: prompts being
   * generated plus prompts queued behind them, across every user talking to
   * it, plus the turns the dispatcher holds outside any queue (holdTurn).
   *
   * A prompt counts from the moment it is enqueued until its queue task ends,
   * after the post-prompt drain and the REST reconciliation. The
   * control-plane asks it before replacing an assistant's AGENTS.md, because
   * that write restarts the slot and a restart mid-generation loses the
   * user's message.
   *
   * A session still being spawned counts too. The child is started BY the
   * first prompt, so the gap between "the user sent something" and "the queue
   * holds it" is a real part of the turn, and it is the part where a restart
   * is most likely to be reported as the assistant simply never answering.
   */
  turnsInFlight(agentId: string): number {
    let n = this.heldTurns.get(agentId) ?? 0;
    for (const entry of this.entries.values()) {
      if (entry.agentId === agentId) n += entry.queue.size();
    }
    for (const key of this.inFlightSpawns.keys()) {
      if (key.startsWith(`${agentId}:`)) n += 1;
    }
    return n;
  }

  /**
   * Count a turn as in flight until the returned function is called, for the
   * moments it sits in no queue: between the tries of a turn held through a
   * restart, while the slot is asked whether it restarted, and while a
   * conversation that outgrew its summary starts over. A control-plane that
   * read the agent as idle then would restart the slot again under it.
   */
  holdTurn(agentId: string): () => void {
    this.heldTurns.set(agentId, (this.heldTurns.get(agentId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.heldTurns.get(agentId) ?? 1) - 1;
      if (n > 0) this.heldTurns.set(agentId, n);
      else this.heldTurns.delete(agentId);
    };
  }

  /**
   * Whether a session whose connection closed lost it to a restart. The bridge
   * closing it is enough; otherwise the slot has to have stopped or restarted
   * since `since`. A probe that throws answers no, which keeps the turn's own
   * failure.
   */
  private async lostToRestart(agent: AgentConfig, since: number, closedByBridge: boolean): Promise<boolean> {
    if (closedByBridge) return true;
    try {
      return await this.slotRestarted(agent, since);
    } catch (err) {
      logger.warn(
        { err, agentId: agent.id },
        "could not read the slot's state — treating the closed session as a failure",
      );
      return false;
    }
  }

  /**
   * The opencode session id this pair is currently talking through.
   *
   * A test seam, and the only way to tell a resumed conversation from a
   * re-created one from the outside: both answer, both look healthy, and only
   * the id says which happened.
   */
  currentSessionId(agentId: string, userId: string): string | undefined {
    return this.entries.get(sessionKey(agentId, userId))?.sessionId;
  }

  /**
   * Why this agent cannot start a session, when the reason is that its slot
   * does not define the mode the assistant runs under. `undefined` means the
   * last session for it selected the mode, or that none has been tried yet.
   *
   * Read by the bridge's liveness snapshot: an agent in this state has a
   * connected channel and answers no message, which is the combination that
   * shows as healthy everywhere else.
   */
  sessionModeFailure(agentId: string): SessionModeUnavailable | undefined {
    return this.sessionModeFailures.get(agentId);
  }

  /**
   * Record the missing mode and build the error that refuses the session.
   * Both callers need the same record and the same sentence, and writing the
   * sentence twice is how the log and the status endpoint end up describing
   * one slot in two ways.
   */
  private refuseForMissingMode(agentId: string, userId: string, mode: string, available: string[]): Error {
    const detail = sessionModeUnavailableDetail(mode, available);
    this.sessionModeFailures.set(agentId, { agentId, requested: mode, available, detail });
    logger.error(
      { agentId, userId, mode, available },
      "the agent slot does not define the session mode this assistant runs under — refusing the session rather than answering as the engine's own agent",
    );
    return new Error(detail);
  }

  // ────────────────────────────────────────────────────────────────
  // Hot ops, called by applyConfigDiff in bridge.ts when agents.yaml
  // changes on disk. addAgent, removeAgent, replaceAgent and
  // updateAllowlist change the shared BridgeConfig in place, so the
  // Dispatcher and allowlist.isAllowed, which read the same object, see the
  // new state.

  /**
   * Register a new Agent so subsequent prompts addressed to it
   * spawn an ACP child. Idempotency: throws if the agent id is
   * already known — the reloader treats "added in diff" and
   * "modified in diff" as separate paths and never calls addAgent
   * twice for the same id.
   */
  addAgent(agent: AgentConfig): void {
    if (this.agentsById.has(agent.id)) {
      throw new Error(`agent id "${agent.id}" is already registered`);
    }
    this.agentsById.set(agent.id, agent);
    this.config.agents.push(agent);
  }

  /**
   * Remove an Agent: kill all its in-flight ACP children, then
   * drop it from agentsById + the shared config. No-op when the
   * id is not registered.
   */
  removeAgent(agentId: string): void {
    if (!this.agentsById.has(agentId)) {
      return;
    }
    this.killAgentSessions(agentId);
    this.agentsById.delete(agentId);
    // An id that comes back later is a different agent with the same name,
    // and must not inherit a verdict on the slot the old one was bound to.
    this.sessionModeFailures.delete(agentId);
    this.config.agents = this.config.agents.filter((a) => a.id !== agentId);
  }

  /**
   * Terminate every ACP child of one agent without removing the agent
   * itself. removeAgent and replaceAgent call it; after replaceAgent the
   * next prompt spawns under the reloaded AgentConfig.
   */
  killAgentSessions(agentId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.agentId !== agentId) continue;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.closedByBridge = true;
      this.flushQueue(entry, "the bridge ended the session to apply a reload");
      if (!entry.closed && !entry.child.killed) {
        try {
          entry.child.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
      this.entries.delete(key);
      // Kept now, not when the child exits: a message arriving in between
      // would find no session and no id, and start the conversation over.
      if (!entry.outgrown) this.rememberResumableSession(key, entry.sessionId);
    }
  }

  /**
   * Put a reloaded config in place of a registered agent's and end the
   * sessions started under the old one. The reload hands this same object to
   * the adapter it creates, so the adapter, the allowlist check and the next
   * session all read one agent: an allowlist a later reload changes in place
   * reaches all three, and the next session spawns under the new command and
   * mode.
   */
  replaceAgent(agent: AgentConfig): void {
    if (!this.agentsById.has(agent.id)) {
      throw new Error(`unknown agent id "${agent.id}"`);
    }
    this.killAgentSessions(agent.id);
    this.agentsById.set(agent.id, agent);
    this.config.agents = this.config.agents.map((a) => (a.id === agent.id ? agent : a));
  }

  /**
   * Swap the `allowed_users` array for one agent without disturbing
   * its sessions. Used when the diff classifies a mutation as
   * `allowed_users_only`. The mutation lands on the SHARED
   * AgentConfig reference so allowlist.isAllowed (which reads from
   * the BridgeConfig) picks up the new set on the next DM.
   */
  updateAllowlist(agentId: string, allowedUsers: string[]): void {
    const agent = this.agentsById.get(agentId);
    if (!agent) {
      throw new Error(`unknown agent id "${agentId}"`);
    }
    agent.allowed_users = [...allowedUsers];
  }

  /**
   * Whether this pair's next message goes to a conversation that already
   * exists: a live session, one being started, or one remembered to resume.
   * False means the next prompt starts a new conversation.
   */
  holdsConversation(agentId: string, userId: string): boolean {
    const key = sessionKey(agentId, userId);
    return this.entries.has(key) || this.inFlightSpawns.has(key) || this.resumableSessions.get(key) !== undefined;
  }

  async prompt(
    agentId: string,
    userId: string,
    text: string,
    onUpdate?: SessionUpdateHandler,
    options?: PromptOptions,
  ): Promise<PromptResult> {
    const agent = this.agentsById.get(agentId);
    if (!agent) throw new Error(`unknown agent id "${agentId}"`);
    if (options?.opensTurn && this.stopping) throw new BridgeStoppingError();

    const key = sessionKey(agentId, userId);
    let entry = this.entries.get(key);
    // A session the bridge is killing, or whose connection already closed, is
    // not one to queue a turn on: the child's exit handler has not run yet. Its
    // id is kept now, because the spawn below wants to resume it.
    if (entry && (entry.closed || entry.closedByBridge || entry.connection.signal.aborted)) {
      this.entries.delete(key);
      if (!entry.outgrown) this.rememberResumableSession(key, entry.sessionId);
      entry = undefined;
    }
    if (!entry) {
      // Dedup concurrent first prompts. Without memoizing the
      // in-flight spawn, two near-simultaneous DMs both pass the
      // `!entry` check, both spawn a child, and the second `set`
      // overwrites the first — leaking one orphan process and splitting
      // the conversation across two sessions.
      let pending = this.inFlightSpawns.get(key);
      if (!pending) {
        pending = this.spawnAndInit(agent, userId);
        this.inFlightSpawns.set(key, pending);
        // This finally-chain is a SECOND consumer of `pending`.
        // If spawnAndInit rejects (a child dies mid-handshake, an EPIPE on a
        // closed stdin, etc.), `await pending` below surfaces the rejection to
        // the caller — but this discarded chain ALSO rejects, and with no
        // `.catch` it is an unhandled rejection: index.ts logs it as an error,
        // and a process without that handler, such as the CLI, exits on it.
        // Swallow it here; the awaiter still handles the real error.
        pending
          .finally(() => {
            if (this.inFlightSpawns.get(key) === pending) this.inFlightSpawns.delete(key);
          })
          .catch(() => {});
      }
      try {
        entry = await pending;
      } catch (err) {
        // The spawn no longer counts the turn and no queue holds it yet, so it
        // is counted here while the slot is asked.
        const asking = this.holdTurn(agentId);
        const restarted = err instanceof SessionStartLost && (await this.lostToRestart(agent, err.spawnedAt, false));
        asking();
        if (restarted) {
          logger.warn(
            { agentId, userId },
            "the slot was down or restarting when the session started — the turn can be sent again",
          );
          throw new SessionRestartError(false, (err as SessionStartLost).cause);
        }
        throw err instanceof SessionStartLost ? err.cause : err;
      }
      this.evictForCapacity(key);
      this.entries.set(key, entry);
    }

    if (options?.opensTurn) {
      await this.settleSummary(agent, userId, entry, options);
      // The summary may have ended the session it was written in, and a
      // prompt queued on a session the bridge ended is refused: the message
      // goes to the session as it now stands, respawned if need be.
      const current = this.entries.get(key);
      if (current !== entry) return this.prompt(agentId, userId, text, onUpdate, options);
    }

    return entry.queue.enqueue(async () => {
      // Waiting, when the bridge started to stop, for its session to start or
      // for the turn ahead of it: this one has not reached the assistant, and
      // does not now. A turn queued behind one whose session the bridge ended
      // never gets here: see flushQueue.
      if (options?.opensTurn && this.stopping) throw new BridgeStoppingError();
      // Track when the last sessionUpdate landed so we can drain
      // post-resolve chunks. Workaround for opencode upstream issue
      // #17505 / #25421: ACP `agent_message_chunk` frames sometimes
      // arrive AFTER the `session/prompt` RPC response with
      // stopReason: end_turn — a server-side race between
      // event-subscription and prompt-RPC reply in opencode acp.
      // Without draining, the caller (the dispatcher or the CLI) sees
      // the final delta as missing and the reply appears empty or
      // truncated.
      //
      // The counters feed the `[turn_telemetry]` line, which operators
      // grep to measure the race in production.
      let lastUpdateAt = Date.now();
      let chunksReceived = 0;
      let textChunks = 0;
      let thoughtChunks = 0;
      // Accumulate everything the ACP delta stream gave us so the
      // reconciler can diff it against the REST snapshot.
      // We also latch the first messageId we see; ACP attaches it to
      // both agent_message_chunk and agent_thought_chunk updates.
      const seen: SeenState = { textSeen: "", reasoningSeen: "" };
      let assistantMessageId: string | undefined;
      // The tool calls this turn has opened and not yet closed. A sub-agent
      // started with the `task` tool works in a session of its own and sends
      // this one nothing until it returns, so a silence that long is the work
      // and not a hang: while one is open only the ceiling ends the turn.
      const openToolCalls = new Set<string>();
      // The summary of its history the session was last found writing. opencode
      // sends nothing over ACP until the summary's first words, so the slot is
      // asked while the turn is silent. An update that belongs to another
      // message is the session past it: a tool call, or a chunk of the answer
      // that follows the summary.
      const askCompaction = this.compactionProbeFor(agent);
      let compaction: { messageId: string } | undefined;
      let asking = false;
      let askedAt = Number.NEGATIVE_INFINITY;
      // When the last ask that was answered was sent.
      let answeredAskAt = Number.NEGATIVE_INFINITY;
      let promptOver = false;
      const compactionIs = (next: { messageId: string } | undefined) => {
        const was = compaction !== undefined;
        compaction = next;
        if (was === (next !== undefined)) return;
        logger.info(
          { agentId: agent.id, userId, sessionId: entry!.sessionId, summaryMessageId: next?.messageId },
          next ? "the session is writing the summary of its history" : "the session is past its summary",
        );
        try {
          options?.onCompaction?.(next !== undefined);
        } catch (err) {
          logger.warn({ err, agentId: agent.id, userId }, "onCompaction threw — ignored");
        }
      };
      const ask = () => {
        if (!askCompaction || asking) return;
        asking = true;
        const sentAt = Date.now();
        askedAt = sentAt;
        void askCompaction(entry!.sessionId)
          .catch((err: unknown) => {
            logger.warn(
              { agentId: agent.id, userId, reason: err instanceof Error ? err.message : String(err) },
              "could not ask the slot whether the session is summarising — taken as not",
            );
            return null;
          })
          .then((messageId) => {
            asking = false;
            // An update that arrived while the ask was out is newer than its answer.
            if (promptOver || lastUpdateAt > sentAt) return;
            answeredAskAt = sentAt;
            compactionIs(messageId ? { messageId } : undefined);
          });
      };
      entry!.onUpdate = (update) => {
        lastUpdateAt = Date.now();
        chunksReceived += 1;
        if (compaction) {
          const mid = (update as { messageId?: string | null }).messageId;
          const chunk =
            update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk";
          const tool = update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update";
          if (tool || (chunk && typeof mid === "string" && mid !== compaction.messageId)) compactionIs(undefined);
        }
        if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
          const id = (update as { toolCallId?: string }).toolCallId;
          const status = (update as { status?: string | null }).status;
          if (id && (status === "completed" || status === "failed")) openToolCalls.delete(id);
          else if (id && update.sessionUpdate === "tool_call") openToolCalls.add(id);
        }
        if (update.sessionUpdate === "agent_message_chunk") {
          textChunks += 1;
          if (update.content.type === "text") seen.textSeen += update.content.text;
          const mid = (update as { messageId?: string }).messageId;
          if (mid && !assistantMessageId) assistantMessageId = mid;
        } else if (update.sessionUpdate === "agent_thought_chunk") {
          thoughtChunks += 1;
          if (update.content.type === "text") seen.reasoningSeen += update.content.text;
          const mid = (update as { messageId?: string }).messageId;
          if (mid && !assistantMessageId) assistantMessageId = mid;
        }
        onUpdate?.(update);
      };
      this.resetIdleTimer(entry!);
      const t0 = Date.now();
      let t1 = 0;
      let drainExit: TurnTelemetry["drainExit"] = "idle";
      let reconciledTextBytes = 0;
      let reconciledReasoningBytes = 0;
      try {
        // Race the prompt RPC against the watchdog. On a fire, SIGTERM the
        // child — its exit handler drops the session from the map, so the next
        // prompt respawns cleanly.
        //
        // An interval rather than one timeout, because what decides is
        // `lastUpdateAt`, which the update handler above moves on every chunk.
        // A turn that keeps streaming keeps re-arming the silence limit and is
        // only ever ended by the ceiling.
        //
        // A silent turn asks every COMPACTION_PROBE_EVERY_MS whether its session
        // is writing its summary. While it is, the silence it may keep is
        // COMPACTION_SILENCE_MS. Otherwise it is ended at the silence limit,
        // on an answer asked after that limit was reached: a summary that
        // started since the previous ask would be cut by an older one.
        let watchdogId: NodeJS.Timeout | undefined;
        const watchdog = new Promise<never>((_, reject) => {
          const startedAt = Date.now();
          watchdogId = setInterval(
            () => {
              const now = Date.now();
              const ranFor = now - startedAt;
              const silentFor = now - lastUpdateAt;
              let silenceMs = this.turnSilenceMs;
              // The ceiling is checked FIRST: a turn that hits both is a turn
              // that ran too long, and saying "the child produced nothing" about
              // one that produced output for forty minutes is the wrong sentence
              // in the log and the wrong copy in front of the user.
              let reason: TurnWatchdogReason | null = ranFor >= this.turnCeilingMs ? "ceiling" : null;
              if (reason === null && openToolCalls.size === 0) {
                if (silentFor >= COMPACTION_PROBE_EVERY_MS && now - askedAt >= COMPACTION_PROBE_EVERY_MS) ask();
                if (compaction) {
                  silenceMs = Math.max(this.turnSilenceMs, COMPACTION_SILENCE_MS);
                  if (silentFor >= silenceMs) reason = "silent";
                } else if (silentFor >= this.turnSilenceMs) {
                  if (!askCompaction || answeredAskAt >= lastUpdateAt + this.turnSilenceMs) reason = "silent";
                  else if (!asking) ask();
                  else if (now - askedAt >= COMPACTION_PROBE_TIMEOUT_MS) reason = "silent";
                }
              }
              if (reason === null) return;
              logger.error(
                {
                  agentId: agent.id,
                  userId,
                  reason,
                  ranFor,
                  silentFor,
                  chunksReceived,
                  compacting: compaction !== undefined,
                },
                reason === "ceiling"
                  ? "turn watchdog fired — the turn passed its ceiling while still running"
                  : "turn watchdog fired — killing the silent opencode child",
              );
              entry!.closedByBridge = true;
              this.flushQueue(entry!, "the watchdog ended the turn ahead of this one");
              try {
                entry!.child.kill("SIGTERM");
              } catch {
                /* already dead */
              }
              // Drop the session NOW (the child's exit handler would do it
              // asynchronously): a prompt arriving right after the kill must
              // respawn, not adopt the dying connection.
              const k = sessionKey(agent.id, userId);
              if (this.entries.get(k) === entry) this.entries.delete(k);
              reject(new TurnWatchdogError(reason, reason === "ceiling" ? this.turnCeilingMs : silenceMs));
            },
            watchdogTick(this.turnSilenceMs, this.turnCeilingMs, COMPACTION_PROBE_EVERY_MS),
          );
          // The interval must not be what keeps the process alive: a bridge
          // whose last turn is in flight should still be able to exit.
          watchdogId.unref?.();
        });
        let response: Awaited<ReturnType<NonNullable<typeof entry>["connection"]["prompt"]>>;
        const prompt: acp.ContentBlock[] = [{ type: "text", text }];
        if (options?.context) {
          prompt.unshift({ type: "text", text: options.context, annotations: { audience: ["assistant"] } });
        }
        try {
          response = await Promise.race([
            entry!.connection.prompt({
              sessionId: entry!.sessionId,
              prompt,
            }),
            watchdog,
          ]);
        } catch (err) {
          // The connection closing is the child going away, not an answer from
          // the agent: an error the agent returns leaves it open. The watchdog's
          // own kill keeps its own error.
          if (
            !(err instanceof TurnWatchdogError) &&
            entry!.connection.signal.aborted &&
            (await this.lostToRestart(agent, entry!.spawnedAt, entry!.closedByBridge))
          ) {
            logger.warn(
              { agentId: agent.id, userId, chunksReceived, closedByBridge: entry!.closedByBridge },
              "the session closed under this turn because it restarted — the turn can be sent again",
            );
            throw new SessionRestartError(chunksReceived > 0, err);
          }
          // Every later turn of this session would be refused the same way,
          // and resuming it after a restart brings the refusal back with it.
          // So it is let go here, and its id with it.
          if (isCompactionOverflow(err)) {
            this.letGo(entry!);
            logger.warn(
              { agentId: agent.id, userId, sessionId: entry!.sessionId, chunksReceived },
              "the session is too large to summarise — let go, the next prompt starts a new one",
            );
            throw new SessionOutgrownError(entry!.sessionId, err);
          }
          throw err;
        } finally {
          // clearInterval, not clearTimeout: the watchdog above repeats, and a
          // timeout cleared with the wrong call would go on ticking for the
          // life of the process.
          clearInterval(watchdogId);
        }
        t1 = Date.now();
        // Debug-log the stopReason for forensic visibility into
        // why a turn ended (end_turn, max_tokens, refusal, …).
        logger.debug({ agentId: agent.id, userId, stopReason: response.stopReason }, "session/prompt resolved");
        // Drain: wait until the stream has been idle for
        // POST_PROMPT_IDLE_MS, or until POST_PROMPT_MAX_DRAIN_MS
        // elapses as a safety ceiling. Captures the post-RPC
        // notifications that opencode acp emits asynchronously.
        //
        // The ceiling is 8 s because turns with tool-call intermediates
        // have been seen emitting their final agent_message_chunk about
        // 3 s after end_turn. A turn that has not streamed for 300 ms
        // exits early through the idle branch.
        const POST_PROMPT_IDLE_MS = 300;
        const POST_PROMPT_MAX_DRAIN_MS = 8000;
        const drainStart = Date.now();
        // Default exit reason if we run out of budget without ever
        // going idle. Updated below on each branch.
        drainExit = "ceiling";
        while (Date.now() - drainStart < POST_PROMPT_MAX_DRAIN_MS) {
          // Short-circuit: if the child already exited, no more
          // chunks will ever arrive — exit the drain immediately.
          if (entry!.closed) {
            drainExit = "closed";
            break;
          }
          const sinceLastUpdate = Date.now() - lastUpdateAt;
          if (sinceLastUpdate >= POST_PROMPT_IDLE_MS) {
            drainExit = "idle";
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        // Shadow-channel reconciliation. After the drain has settled we
        // ask opencode serve for the canonical assistant message and
        // replay any text/reasoning the ACP delta stream missed as
        // synthetic chunks. With no messageId, no endpoint configured, or
        // a failed fetch (logged as a warning), the turn keeps what the
        // stream and the drain delivered.
        if (assistantMessageId) {
          // Container name is the third spawn arg in the appliance's
          // `docker exec -i <container> opencode acp` shape, the same
          // name the bridge talks to over the docker socket. With fewer
          // than three args it falls back to `cerase-agent-<agent id>`.
          const containerName = agent.spawn.args[2] ?? `cerase-agent-${agent.id}`;
          const endpoint = this.endpointResolver(containerName);
          if (endpoint) {
            try {
              const canonical = await this.canonicalFetcher(endpoint, entry!.sessionId, assistantMessageId);
              if (canonical) {
                const deltas = reconcile(seen, canonical);
                for (const d of deltas) {
                  const update: SessionUpdate =
                    d.kind === "text"
                      ? ({
                          sessionUpdate: "agent_message_chunk",
                          content: { type: "text", text: d.text },
                        } as SessionUpdate)
                      : ({
                          sessionUpdate: "agent_thought_chunk",
                          content: { type: "text", text: d.text },
                        } as SessionUpdate);
                  onUpdate?.(update);
                  if (d.kind === "text") reconciledTextBytes += d.text.length;
                  else reconciledReasoningBytes += d.text.length;
                }
              }
            } catch (err) {
              logger.warn({ agentId: agent.id, err: (err as Error).message }, "M16 reconciliation failed — skipped");
            }
          }
        }
        return { stopReason: response.stopReason };
      } finally {
        compactionIs(undefined);
        promptOver = true;
        const t2 = Date.now();
        entry!.onUpdate = undefined;
        entry!.lastTurnAt = t2;
        if (!entry!.outgrown) this.resetIdleTimer(entry!);
        const telemetry: TurnTelemetry = {
          agentId: agent.id,
          userId,
          chunksReceived,
          textChunks,
          thoughtChunks,
          drainExit,
          promptToEndTurnMs: t1 > 0 ? t1 - t0 : 0,
          endTurnToDrainDoneMs: t1 > 0 ? t2 - t1 : 0,
          lastChunkAgeMs: chunksReceived > 0 ? t2 - lastUpdateAt : 0,
          reconciledTextBytes,
          reconciledReasoningBytes,
        };
        logger.info({ ...telemetry, marker: "turn_telemetry" }, "[turn_telemetry]");
        try {
          this.onTelemetry?.(telemetry);
        } catch (err) {
          logger.warn({ err }, "onTelemetry hook threw — ignored");
        }
      }
    });
  }

  async shutdown(): Promise<void> {
    const entries = Array.from(this.entries.values());
    this.entries.clear();
    for (const e of entries) {
      if (e.idleTimer) clearTimeout(e.idleTimer);
      // Nothing is sent again after a shutdown: a stopping bridge keeps a
      // queued turn for the next one, and any other shutdown fails it.
      e.queue.flush(() =>
        this.stopping
          ? new BridgeStoppingError()
          : new Error("the bridge shut its sessions down before this turn reached the assistant"),
      );
      if (!e.closed && !e.child.killed) {
        try {
          e.child.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
    }
    // Wait briefly for children to exit
    await Promise.all(
      entries.map(
        (e) =>
          new Promise<void>((resolve) => {
            if (e.closed) return resolve();
            e.child.once("exit", () => resolve());
            // safety: don't hang the shutdown forever
            setTimeout(() => resolve(), 1000).unref();
          }),
      ),
    );
  }

  private async spawnAndInit(agent: AgentConfig, userId: string): Promise<SessionEntry> {
    logger.info({ agentId: agent.id, userId, command: agent.spawn.command }, "spawning ACP child");
    const spawnedAt = Date.now();
    const child = this.spawnFn(agent.spawn.command, agent.spawn.args);
    if (!child.stdin || !child.stdout) {
      throw new Error(`spawned ACP child for "${agent.id}" has no stdin/stdout — check spawn.command + stdio config`);
    }

    // A child that dies mid-handshake (or mid-turn) leaves the
    // ACP stream writing to a closed pipe → EPIPE. Swallow those at the
    // child/stdin level so they surface as a rejected handshake/turn
    // (handled below) instead of an unhandled process-level rejection
    // that could crash the bridge.
    child.on("error", (err) => {
      logger.warn({ err, agentId: agent.id, userId }, "ACP child process error");
    });
    child.stdin.on("error", (err) => {
      logger.warn({ err, agentId: agent.id, userId }, "ACP child stdin error (likely child exited)");
    });

    // Wire the ACP client. The client handler implements the Client
    // interface: it forwards sessionUpdate notifications to the current
    // entry's onUpdate callback (the active prompt() invocation), and
    // answers permission requests automatically through
    // permission-policy.ts.
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );

    let entryRef: SessionEntry | undefined;

    const connection = new acp.ClientSideConnection(
      (_agentConn) => ({
        async sessionUpdate(params: acp.SessionNotification) {
          // Debug-only visibility into every notification kind we
          // receive. Useful when investigating "where did the reply
          // go?" — non-text or non-agent_message_chunk updates that
          // the CLI silently drops show up here.
          logger.debug({ agentId: agent.id, userId, update: params.update }, "sessionUpdate received");
          entryRef?.onUpdate?.(params.update);
        },
        async requestPermission(params: acp.RequestPermissionRequest) {
          // DM-only agents trust the container sandbox + non-root uid as the
          // real security boundary, not the per-tool permission UI.
          // Auto-cancelling was causing the LLM to read "user rejected" as
          // "stop" and go silent. See src/permission-policy.ts for the
          // rationale.
          const outcome = decidePermissionOutcome(params);
          logger.info(
            {
              agentId: agent.id,
              userId,
              toolCallId: params.toolCall?.toolCallId,
              outcome: outcome.outcome === "selected" ? `selected:${outcome.optionId}` : outcome.outcome,
            },
            "agent requested permission in-DM — auto-decided via permission-policy",
          );
          return { outcome };
        },
      }),
      stream,
    );

    // ACP handshake. If initialize()/newSession() throws, the
    // spawned child is still alive and unreferenced — kill it before
    // rethrowing so repeated failed spawns don't accumulate orphans.
    let sessionId: string;
    try {
      const init = await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });

      // Resume the conversation this pair was already having, when there is
      // one. `session/load` replays the stored history into the fresh process;
      // the replayed notifications land while `entryRef` is still undefined,
      // so nothing forwards them to the DM as new messages.
      //
      // Measured against the running slot rather than assumed: the binary
      // answers `loadSession: true`, and a phrase written before a
      // `docker restart` is recalled after it. The capability is still read
      // from the handshake — an older slot image that does not offer it must
      // fall through to a new session, not fail.
      const resumeKey = sessionKey(agent.id, userId);
      const previousSessionId = this.resumableSessions.get(resumeKey);
      let resumed: string | undefined;
      // Whichever of the two calls produced this session also said which
      // modes it can run in. Both carry the advertisement and only one of
      // them runs, so it is captured here rather than re-derived later.
      let advertisement: ModeAdvertisement | undefined;
      if (previousSessionId && init.agentCapabilities?.loadSession) {
        try {
          advertisement = await connection.loadSession({
            sessionId: previousSessionId,
            cwd: agent.cwd,
            mcpServers: [],
          });
          resumed = previousSessionId;
          logger.info(
            { agentId: agent.id, userId, sessionId: previousSessionId },
            "resumed the previous ACP session — the restart is invisible to the user",
          );
        } catch (loadErr) {
          // Expected, not a fault: the slot entrypoint wipes `opencode.db`
          // whenever the opencode version changes, so an image upgrade takes
          // every session id on the box with it. Forget it and start clean,
          // on disk too, or the next bridge would try it again.
          this.resumableSessions.forget(resumeKey, previousSessionId);
          logger.info(
            { err: loadErr, agentId: agent.id, userId, sessionId: previousSessionId },
            "previous ACP session could not be loaded — starting a new one",
          );
        }
      }

      // A loaded session does not come back on the assistant's model. opencode
      // restores it from the session's LAST USER MESSAGE, uses it for every
      // later prompt and stamps each new user message with it, so whatever
      // route that message carried is the route the conversation runs on from
      // then on. A background compaction once stamped one with its own route,
      // reasoning switched off, and every later turn of that conversation ran
      // there and wrote its reasoning into the answer the person received.
      //
      // So the model is set back before the first prompt, whenever the load
      // reports anything other than the configured one, including nothing at
      // all. A new session needs none of this: it starts on the slot's
      // default, which is the assistant's model.
      //
      // A refused set means the session cannot be put back on the right model,
      // and running it on the wrong one is the defect itself. It is forgotten
      // like a session that failed to load, and the conversation starts over on
      // a new session.
      if (resumed && agent.model) {
        const restored = currentModelOf(advertisement);
        if (restored !== agent.model) {
          try {
            await connection.setSessionConfigOption({ sessionId: resumed, configId: "model", value: agent.model });
            logger.info(
              { agentId: agent.id, userId, sessionId: resumed, restored: restored ?? null, model: agent.model },
              `the resumed session's model ${restored ?? "(not reported)"} was set back to ${agent.model}`,
            );
          } catch (modelErr) {
            this.resumableSessions.forget(resumeKey, resumed);
            logger.warn(
              {
                err: modelErr,
                agentId: agent.id,
                userId,
                sessionId: resumed,
                restored: restored ?? null,
                model: agent.model,
              },
              "the resumed session's model could not be set back — starting a new session on the slot's default",
            );
            resumed = undefined;
            advertisement = undefined;
          }
        }
      }

      // `agent.cwd` is the path inside the agent container — DON'T use
      // process.cwd() here, that would leak the host/bridge cwd into the
      // ACP child's session state. Default `/home/agent/cerase/workspace`
      // comes from the config schema.
      if (resumed) {
        sessionId = resumed;
      } else {
        const created = await connection.newSession({
          cwd: agent.cwd,
          mcpServers: [],
        });
        sessionId = created.sessionId;
        advertisement = created;
      }

      // Select the primary agent this session runs under — by default the
      // de-identified Cerase one the control-plane's SlotWriter renders into
      // the slot's opencode.json, so opencode uses the Cerase base prompt
      // instead of its built-in one. `opencode acp` exposes no flag to pick an
      // agent; the ACP way is to set the session mode, because opencode maps
      // its primary agents to modes.
      //
      // Which agent is a per-agent CONFIG value rather than a constant, so a
      // caller with a different job can ask for a different one. The health
      // probe does: it needs an assistant that answers one word, and the
      // customer's assistant reasonably answers a paragraph.
      //
      // The rule is that the session runs under the mode it asked for or it
      // does not run. Carrying on without it would have opencode's own agent
      // answer the customer, a different assistant under this one's name,
      // with a warning line as the only trace. A refused session is a fault
      // someone can act on.
      //
      // The absence is a property of the slot, not of the session, so it is
      // remembered per agent and served on the status endpoint. It is not
      // cached as a verdict: every turn re-asks, so a slot re-rendered while
      // the bridge runs starts working again on the next message rather than
      // after a restart.
      const decision = decideSessionMode(advertisement, agent.mode);
      if (decision.outcome === "absent") {
        // The handshake already listed the modes, so the request that could
        // only come back "mode not found" is never sent.
        throw this.refuseForMissingMode(agent.id, userId, decision.mode, decision.available);
      }
      try {
        await connection.setSessionMode({ sessionId, modeId: decision.mode });
        this.sessionModeFailures.delete(agent.id);
      } catch (modeErr) {
        if (decision.outcome === "select") {
          // The agent listed this mode and then refused it. Whatever that is,
          // the session is not running the profile it was told it would.
          logger.error(
            { err: modeErr, agentId: agent.id, userId, mode: decision.mode },
            "the agent advertised this session mode and then rejected it — refusing the session",
          );
          throw this.refuseForMissingMode(agent.id, userId, decision.mode, decision.available);
        }
        // The agent advertised no mode system at all. Nothing in this
        // deployment can add one to it, so refusing here would only make the
        // bridge unusable against an agent the protocol allows. Distinct from
        // a slot that has modes and is missing this one, which is a
        // configuration defect and is refused above.
        logger.warn(
          { err: modeErr, agentId: agent.id, userId, mode: decision.mode },
          "the agent advertised no session modes and rejected the request — the session keeps the agent's own default",
        );
      }
    } catch (err) {
      logger.error({ err, agentId: agent.id, userId }, "ACP handshake failed — killing child");
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      // The child went away before the handshake finished, which is what a
      // `docker exec` into a stopped or restarting slot does. Whether that is
      // what happened is the caller's question to the slot.
      if (connection.signal.aborted) throw new SessionStartLost(err, spawnedAt);
      throw err;
    }

    const entry: SessionEntry = {
      agentId: agent.id,
      userId,
      child,
      connection,
      sessionId,
      queue: new PromptQueue(),
      lastTurnAt: Date.now(),
      closed: false,
      spawnedAt,
      closedByBridge: false,
      outgrown: false,
    };
    entryRef = entry;
    // Recorded now, while the session is alive, and not only when its child
    // exits: a bridge that is stopped or killed does not wait for that.
    this.rememberResumableSession(sessionKey(agent.id, userId), sessionId);

    // Crash listener: remove from map on exit so the next prompt
    // respawns transparently.
    child.once("exit", (code, signal) => {
      logger.info({ agentId: agent.id, userId, code, signal }, "ACP child exited");
      entry.closed = true;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      const key = sessionKey(agent.id, userId);
      if (this.entries.get(key) === entry) this.entries.delete(key);
      if (!entry.outgrown) this.rememberResumableSession(key, entry.sessionId);
    });

    this.resetIdleTimer(entry);
    return entry;
  }

  /**
   * Refuse the turns queued behind the one running on a session the bridge is
   * ending, so none of them is sent to the child going away: one read there
   * can be acted on and then sent again to the next session. Each is refused
   * in its place, after the turn ahead of it has ended, as a turn lost to a
   * restart, which the dispatcher sends to the session that replaces this
   * one. While the bridge stops it is refused as not sent instead, and kept
   * for the next bridge.
   */
  private flushQueue(entry: SessionEntry, why: string): void {
    entry.queue.flush(() =>
      this.stopping ? new BridgeStoppingError() : new SessionRestartError(false, new Error(why)),
    );
  }

  /**
   * Record the session a pair is in, so the next spawn for the same pair can
   * load it instead of starting cold: see ResumableSessions.
   */
  private rememberResumableSession(key: string, sessionId: string): void {
    this.resumableSessions.remember(key, sessionId);
  }

  /** Test seam: how many sessions are currently resumable. */
  resumableSessionCount(): number {
    return this.resumableSessions.size;
  }

  /**
   * Let go of a session the runtime can no longer summarise: end its child and
   * forget its id, so the next prompt for the pair starts a new session rather
   * than loading this one. Loading it is what the console's restart and every
   * slot restart would otherwise do, and each brought the same refusal back.
   */
  private letGo(entry: SessionEntry): void {
    const key = sessionKey(entry.agentId, entry.userId);
    entry.outgrown = true;
    entry.closedByBridge = true;
    // A turn queued behind this one goes to the session that replaces it.
    this.flushQueue(entry, "the session was let go because it outgrew its summary");
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (this.entries.get(key) === entry) this.entries.delete(key);
    this.resumableSessions.forget(key, entry.sessionId);
    if (!entry.closed && !entry.child.killed) {
      try {
        entry.child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
  }

  /**
   * Enforce session.max_concurrent as a REAL ceiling. Before
   * inserting a new (agent,user) session, while we're at/over the cap, evict
   * the least-recently-used session (kill its child) to make room. Without
   * this, `prompt()` spawned one `docker exec` child per (agent,user) with no
   * bound — a DM flood / many inject user_ids meant unbounded process+memory
   * growth. `exceptKey` is the session we're about to insert (not yet in the
   * map) and is never chosen.
   */
  private evictForCapacity(exceptKey: string): void {
    while (this.entries.size >= this.maxConcurrent) {
      let lruKey: string | undefined;
      let lruAt = Infinity;
      for (const [k, e] of this.entries) {
        if (k === exceptKey) continue;
        if (e.lastTurnAt < lruAt) {
          lruAt = e.lastTurnAt;
          lruKey = k;
        }
      }
      if (!lruKey) break;
      const victim = this.entries.get(lruKey)!;
      logger.warn(
        { evicted: lruKey, max: this.maxConcurrent },
        "max_concurrent reached — evicting least-recently-used ACP session",
      );
      if (victim.idleTimer) clearTimeout(victim.idleTimer);
      victim.closedByBridge = true;
      this.flushQueue(victim, "the bridge ended the session to make room for another");
      if (!victim.closed && !victim.child.killed) {
        try {
          victim.child.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
      this.entries.delete(lruKey);
      // As in killAgentSessions: the id is kept before the child has exited.
      if (!victim.outgrown) this.rememberResumableSession(lruKey, victim.sessionId);
    }
  }

  private resetIdleTimer(entry: SessionEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      logger.info({ agentId: entry.agentId, userId: entry.userId }, "killing idle ACP child");
      entry.closedByBridge = true;
      this.flushQueue(entry, "the bridge ended the idle session");
      try {
        entry.child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }, this.idleMs);
  }
}

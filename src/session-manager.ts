import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentConfig, BridgeConfig } from "./config.js";
import { makeLogger } from "./logger.js";
import { type CanonicalFetcher, defaultEndpointForAgent, defaultFetcher, type RestEndpoint } from "./opencode-rest.js";
import { decidePermissionOutcome } from "./permission-policy.js";
import { PromptQueue } from "./prompt-queue.js";
import { reconcile, type SeenState } from "./reconciler.js";

const logger = makeLogger("cerase-acp.session-manager");

/**
 * Streaming session-update events the caller cares about. We forward the
 * raw ACP SessionUpdate union (agent_message_chunk, tool_call,
 * tool_call_update, plan, agent_thought_chunk, etc.) — the stream-buffer
 * in M4 picks the cases it cares about.
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
 * production: if `drainExit === "ceiling"` or `lastChunkAgeMs` is
 * near `POST_PROMPT_MAX_DRAIN_MS` we know the drain bound needs more
 * room or the M16 reconciler should kick in.
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
   * Bytes of `agent_message_chunk` content recovered via M16 REST
   * reconciliation after the drain loop. `0` is the happy path —
   * the ACP stream delivered everything. Any non-zero value flags
   * an upstream race that the M16 shadow channel just patched.
   */
  reconciledTextBytes: number;
  /** Same as above but for `agent_thought_chunk` (reasoning) bytes. */
  reconciledReasoningBytes: number;
}

export interface SessionManagerOptions {
  /** Subscribe to per-turn telemetry. Fires AFTER the drain loop. */
  onTelemetry?: (t: TurnTelemetry) => void;
  /**
   * Inject a canonical-message fetcher for M16 shadow-channel
   * reconciliation. Tests use this to substitute a canned reply;
   * production omits it and `defaultFetcher` (hits the opencode
   * serve REST endpoint) is used.
   */
  canonicalFetcher?: CanonicalFetcher;
  /**
   * Inject an endpoint resolver. Tests use a fake endpoint;
   * production passes the agent's container name (derived from
   * `spawn.args` in agents.yaml) to `defaultEndpointForAgent`
   * which reads `OPENCODE_SERVER_PASSWORD` from env. Returning
   * `null` disables reconciliation for that agent (logged once,
   * then quiet).
   */
  endpointResolver?: (containerName: string) => RestEndpoint | null;
  /**
   * Per-turn watchdog: a hung opencode child used to block
   * that user's PromptQueue forever (until the idle kill). When
   * `connection.prompt()` hasn't resolved within this budget the child
   * is killed, the turn rejects (the dispatcher sends the localized
   * error) and the next prompt respawns. Defaults to 10 minutes —
   * generous for long tool-using turns; override in tests.
   */
  turnTimeoutMs?: number;
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
}

const sessionKey = (agentId: string, userId: string) => `${agentId}:${userId}`;

// How many dead sessions stay resumable. One short string per (agent,user)
// that has ever talked, so the map would otherwise grow for the life of the
// process; the oldest are dropped first and the only cost of dropping one is
// that a very old conversation restarts cold.
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
  // The opencode session id of the last child for each (agent,user), kept
  // AFTER that child dies. It is what makes a restart survivable: the slot
  // restarts for many ordinary reasons — a skill install rewrites AGENTS.md
  // and the entrypoint watcher SIGTERMs opencode, the idle killer fires, the
  // image is updated — and every one of them used to start the next message
  // from zero while the user saw no explanation. opencode keeps the session
  // in its own SQLite on a named volume, so the id stays valid across the
  // container's death; the state lives there, not here.
  private resumableSessions = new Map<string, string>();
  private agentsById = new Map<string, AgentConfig>();
  private idleMs: number;
  // session.max_concurrent enforced as a real ceiling (LRU eviction).
  private maxConcurrent: number;
  private onTelemetry?: (t: TurnTelemetry) => void;
  private canonicalFetcher: CanonicalFetcher;
  private endpointResolver: (containerName: string) => RestEndpoint | null;

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
    this.turnTimeoutMs = options?.turnTimeoutMs ?? 10 * 60 * 1000;
  }

  private turnTimeoutMs: number;

  activeSessionCount(): number {
    return this.entries.size;
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

  // ────────────────────────────────────────────────────────────────
  // Hot ops — invoked by ConfigReloader (M-auto-reload v0.2) when
  // `agents.yaml` changes on disk. All four mutate the shared
  // BridgeConfig in place so downstream consumers reading from the
  // same reference (Dispatcher, allowlist.isAllowed) see the new
  // state without a config-passing refactor.

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
   * id is not registered (idempotent — the reloader can fire
   * concurrent diffs without races).
   */
  removeAgent(agentId: string): void {
    if (!this.agentsById.has(agentId)) {
      return;
    }
    this.killAgentSessions(agentId);
    this.agentsById.delete(agentId);
    this.config.agents = this.config.agents.filter((a) => a.id !== agentId);
  }

  /**
   * Terminate every (user, agentId) ACP child for one agent without
   * removing the agent itself — used when the diff classifies a
   * mutation as `bot_token_or_spawn` (the adapter and children
   * must be torn down, but the agent is still in the config).
   * Subsequent prompts respawn under the updated AgentConfig.
   */
  killAgentSessions(agentId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.agentId !== agentId) continue;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      if (!entry.closed && !entry.child.killed) {
        try {
          entry.child.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
      this.entries.delete(key);
    }
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

  async prompt(agentId: string, userId: string, text: string, onUpdate?: SessionUpdateHandler): Promise<PromptResult> {
    const agent = this.agentsById.get(agentId);
    if (!agent) throw new Error(`unknown agent id "${agentId}"`);

    const key = sessionKey(agentId, userId);
    let entry = this.entries.get(key);
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
        // `.catch` it becomes an UNHANDLED rejection that terminates the whole
        // multi-tenant bridge (Node ≥15) over one user's recoverable per-turn
        // failure. Swallow it here; the awaiter still handles the real error.
        pending
          .finally(() => {
            if (this.inFlightSpawns.get(key) === pending) this.inFlightSpawns.delete(key);
          })
          .catch(() => {});
      }
      entry = await pending;
      this.evictForCapacity(key);
      this.entries.set(key, entry);
    }

    return entry.queue.enqueue(async () => {
      // Track when the last sessionUpdate landed so we can drain
      // post-resolve chunks. Workaround for opencode upstream issue
      // #17505 / #25421: ACP `agent_message_chunk` frames sometimes
      // arrive AFTER the `session/prompt` RPC response with
      // stopReason: end_turn — a server-side race between
      // event-subscription and prompt-RPC reply in opencode acp.
      // Without draining, the caller (CLI / Discord adapter) sees
      // the final delta as missing and the reply appears empty or
      // truncated.
      //
      // Counters fuel the M15 `[turn_telemetry]` line: operators
      // grep these to dimension the race in production and decide
      // whether the M16 reconciler needs to fire.
      let lastUpdateAt = Date.now();
      let chunksReceived = 0;
      let textChunks = 0;
      let thoughtChunks = 0;
      // M16 bookkeeping — accumulate everything the ACP delta stream
      // gave us so the reconciler can diff against the REST snapshot.
      // We also latch the first messageId we see; ACP attaches it to
      // both agent_message_chunk and agent_thought_chunk updates.
      const seen: SeenState = { textSeen: "", reasoningSeen: "" };
      let assistantMessageId: string | undefined;
      entry!.onUpdate = (update) => {
        lastUpdateAt = Date.now();
        chunksReceived += 1;
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
        // Race the prompt RPC against the watchdog. On
        // timeout, SIGTERM the child — its exit handler drops the
        // session from the map, so the next prompt respawns cleanly.
        let watchdogId: NodeJS.Timeout | undefined;
        const watchdog = new Promise<never>((_, reject) => {
          watchdogId = setTimeout(() => {
            logger.error(
              { agentId: agent.id, userId, timeoutMs: this.turnTimeoutMs },
              "turn watchdog fired — killing the hung opencode child",
            );
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
            reject(
              new Error(
                `turn watchdog: opencode child unresponsive for ${this.turnTimeoutMs}ms — killed and respawning on next prompt`,
              ),
            );
          }, this.turnTimeoutMs);
        });
        let response: Awaited<ReturnType<NonNullable<typeof entry>["connection"]["prompt"]>>;
        try {
          response = await Promise.race([
            entry!.connection.prompt({
              sessionId: entry!.sessionId,
              prompt: [{ type: "text", text }],
            }),
            watchdog,
          ]);
        } finally {
          clearTimeout(watchdogId);
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
        // Ceiling raised 2000 → 8000 in M15 after end-to-end tests
        // showed turns with tool-call intermediates emitting their
        // final agent_message_chunk ~3s after end_turn. 8s is
        // generous — turns that haven't streamed in 300ms exit
        // early via the idle branch anyway.
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
        // M16: shadow-channel reconciliation. After the drain has
        // settled we ask opencode serve for the canonical assistant
        // message and replay any text/reasoning the ACP delta stream
        // missed as synthetic chunks. Failure modes (no messageId yet,
        // no endpoint configured, fetch failure) all degrade silently
        // to "no reconciliation" — the M15 drain alone still covered
        // the majority of cases.
        if (assistantMessageId) {
          // Container name is the third spawn arg in the canonical
          // `docker exec -i <container> opencode acp` shape — the
          // same name the bridge talks to over the docker socket.
          // Falls back to `cerase-agent-${agent.id}` for legacy
          // (pre-slot-pool) agents.yaml shapes where args[2] isn't
          // a container name.
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
        const t2 = Date.now();
        entry!.onUpdate = undefined;
        entry!.lastTurnAt = t2;
        this.resetIdleTimer(entry!);
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
    // auto-cancels permission requests (PoC policy — no in-DM buttons).
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
      if (previousSessionId && init.agentCapabilities?.loadSession) {
        try {
          await connection.loadSession({
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
          // every session id on the box with it. Forget it and start clean.
          this.resumableSessions.delete(resumeKey);
          logger.info(
            { err: loadErr, agentId: agent.id, userId, sessionId: previousSessionId },
            "previous ACP session could not be loaded — starting a new one",
          );
        }
      }

      // `agent.cwd` is the path inside the agent container — DON'T use
      // process.cwd() here, that would leak the host/bridge cwd into the
      // ACP child's session state. Default `/root/cerase/workspace`
      // comes from the config schema.
      if (resumed) {
        sessionId = resumed;
      } else {
        ({ sessionId } = await connection.newSession({
          cwd: agent.cwd,
          mcpServers: [],
        }));
      }

      // Select the de-identified "cerase" primary agent
      // (opencode.json `agent.cerase`, rendered by control-plane's SlotWriter) so
      // opencode uses the Cerase base prompt instead of its built-in "You are
      // opencode…" one. `opencode acp` exposes no `--agent` flag; the ACP way is to
      // set the session mode (opencode maps its primary agents to session modes).
      // Best-effort: if the mode is unavailable (older slot render), the session
      // keeps opencode's default agent rather than failing — a working assistant
      // beats a dead session.
      try {
        await connection.setSessionMode({ sessionId, modeId: "cerase" });
      } catch (modeErr) {
        logger.warn(
          { err: modeErr, agentId: agent.id, userId },
          "setSessionMode(cerase) failed — session keeps opencode's default agent",
        );
      }
    } catch (err) {
      logger.error({ err, agentId: agent.id, userId }, "ACP handshake failed — killing child");
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
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
    };
    entryRef = entry;

    // Crash listener: remove from map on exit so the next prompt
    // respawns transparently.
    child.once("exit", (code, signal) => {
      logger.info({ agentId: agent.id, userId, code, signal }, "ACP child exited");
      entry.closed = true;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      const key = sessionKey(agent.id, userId);
      if (this.entries.get(key) === entry) this.entries.delete(key);
      this.rememberResumableSession(key, entry.sessionId);
    });

    this.resetIdleTimer(entry);
    return entry;
  }

  /**
   * Record the session a dead child was holding, so the next spawn for the
   * same pair can load it instead of starting cold.
   *
   * Re-inserting moves the key to the end, which makes the eviction below
   * least-recently-used rather than first-ever-seen: the pair that talked
   * most recently is the one most likely to talk again.
   */
  private rememberResumableSession(key: string, sessionId: string): void {
    if (!sessionId) return;
    this.resumableSessions.delete(key);
    this.resumableSessions.set(key, sessionId);
    while (this.resumableSessions.size > RESUMABLE_SESSIONS_MAX) {
      const oldest = this.resumableSessions.keys().next();
      if (oldest.done) break;
      this.resumableSessions.delete(oldest.value);
    }
  }

  /** Test seam: how many dead sessions are currently resumable. */
  resumableSessionCount(): number {
    return this.resumableSessions.size;
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
      if (!victim.closed && !victim.child.killed) {
        try {
          victim.child.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
      this.entries.delete(lruKey);
    }
  }

  private resetIdleTimer(entry: SessionEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      logger.info({ agentId: entry.agentId, userId: entry.userId }, "killing idle ACP child");
      try {
        entry.child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }, this.idleMs);
  }
}

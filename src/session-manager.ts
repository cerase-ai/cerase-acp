import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { makeLogger } from "./logger.js";
import type { BridgeConfig, AgentConfig } from "./config.js";
import { PromptQueue } from "./prompt-queue.js";

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
}

export interface SessionManagerOptions {
  /** Subscribe to per-turn telemetry. Fires AFTER the drain loop. */
  onTelemetry?: (t: TurnTelemetry) => void;
}

/**
 * Optional injection point so tests can swap real `child_process.spawn`
 * for a custom spawner. Production code uses the default.
 */
export type SpawnFn = (command: string, args: string[]) => ChildProcess;

const defaultSpawn: SpawnFn = (command, args) =>
  spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });

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

/**
 * Owns the lifecycle of one ACP child per (agent, user) pair. Lazy-spawns
 * on first prompt; reuses on subsequent prompts; respawns transparently
 * after the child exits; kills idle children after the configured
 * timeout.
 */
export class SessionManager {
  private entries = new Map<string, SessionEntry>();
  private agentsById = new Map<string, AgentConfig>();
  private idleMs: number;
  private onTelemetry?: (t: TurnTelemetry) => void;

  constructor(
    private config: BridgeConfig,
    private spawnFn: SpawnFn = defaultSpawn,
    options?: SessionManagerOptions,
  ) {
    for (const a of config.agents) this.agentsById.set(a.id, a);
    this.idleMs = config.session.idle_timeout_minutes * 60 * 1000;
    this.onTelemetry = options?.onTelemetry;
  }

  activeSessionCount(): number {
    return this.entries.size;
  }

  async prompt(
    agentId: string,
    userId: string,
    text: string,
    onUpdate?: SessionUpdateHandler,
  ): Promise<PromptResult> {
    const agent = this.agentsById.get(agentId);
    if (!agent) throw new Error(`unknown agent id "${agentId}"`);

    const key = sessionKey(agentId, userId);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = await this.spawnAndInit(agent, userId);
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
      entry!.onUpdate = (update) => {
        lastUpdateAt = Date.now();
        chunksReceived += 1;
        if (update.sessionUpdate === "agent_message_chunk") textChunks += 1;
        else if (update.sessionUpdate === "agent_thought_chunk") thoughtChunks += 1;
        onUpdate?.(update);
      };
      this.resetIdleTimer(entry!);
      const t0 = Date.now();
      let t1 = 0;
      let drainExit: TurnTelemetry["drainExit"] = "idle";
      try {
        const response = await entry!.connection.prompt({
          sessionId: entry!.sessionId,
          prompt: [{ type: "text", text }],
        });
        t1 = Date.now();
        // Debug-log the stopReason for forensic visibility into
        // why a turn ended (end_turn, max_tokens, refusal, …).
        logger.debug(
          { agentId: agent.id, userId, stopReason: response.stopReason },
          "session/prompt resolved",
        );
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
    logger.info(
      { agentId: agent.id, userId, command: agent.spawn.command },
      "spawning ACP child",
    );
    const child = this.spawnFn(agent.spawn.command, agent.spawn.args);
    if (!child.stdin || !child.stdout) {
      throw new Error(
        `spawned ACP child for "${agent.id}" has no stdin/stdout — check spawn.command + stdio config`,
      );
    }

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
          logger.debug(
            { agentId: agent.id, userId, update: params.update },
            "sessionUpdate received",
          );
          entryRef?.onUpdate?.(params.update);
        },
        async requestPermission(_params: acp.RequestPermissionRequest) {
          // PoC: in-DM permission UI is forbidden (M2 UX rules). Auto-
          // cancel any permission request. This is NORMAL behaviour
          // in scope — the agent retrying a blocked tool is part of
          // the LLM loop, not an operator-actionable event. Logged at
          // INFO so default CLI/daemon runs at warn-level stay quiet;
          // operators investigating can `--log info` to see retries.
          logger.info(
            { agentId: agent.id, userId },
            "agent requested permission in-DM — auto-cancelled (PoC policy)",
          );
          return { outcome: { outcome: "cancelled" } };
        },
      }),
      stream,
    );

    // ACP handshake
    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });

    // `agent.cwd` is the path inside the agent container — DON'T use
    // process.cwd() here, that would leak the host/bridge cwd into the
    // ACP child's session state. Default `/root/cerase/workspace`
    // comes from the config schema.
    const { sessionId } = await connection.newSession({
      cwd: agent.cwd,
      mcpServers: [],
    });

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
      logger.info(
        { agentId: agent.id, userId, code, signal },
        "ACP child exited",
      );
      entry.closed = true;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      const key = sessionKey(agent.id, userId);
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });

    this.resetIdleTimer(entry);
    return entry;
  }

  private resetIdleTimer(entry: SessionEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      logger.info(
        { agentId: entry.agentId, userId: entry.userId },
        "killing idle ACP child",
      );
      try {
        entry.child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }, this.idleMs);
  }
}

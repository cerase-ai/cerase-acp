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

  constructor(
    private config: BridgeConfig,
    private spawnFn: SpawnFn = defaultSpawn,
  ) {
    for (const a of config.agents) this.agentsById.set(a.id, a);
    this.idleMs = config.session.idle_timeout_minutes * 60 * 1000;
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
      let lastUpdateAt = Date.now();
      entry!.onUpdate = (update) => {
        lastUpdateAt = Date.now();
        onUpdate?.(update);
      };
      this.resetIdleTimer(entry!);
      try {
        const response = await entry!.connection.prompt({
          sessionId: entry!.sessionId,
          prompt: [{ type: "text", text }],
        });
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
        const POST_PROMPT_IDLE_MS = 300;
        const POST_PROMPT_MAX_DRAIN_MS = 2000;
        const drainStart = Date.now();
        while (Date.now() - drainStart < POST_PROMPT_MAX_DRAIN_MS) {
          // Short-circuit: if the child already exited, no more
          // chunks will ever arrive — exit the drain immediately.
          if (entry!.closed) break;
          const sinceLastUpdate = Date.now() - lastUpdateAt;
          if (sinceLastUpdate >= POST_PROMPT_IDLE_MS) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        return { stopReason: response.stopReason };
      } finally {
        entry!.onUpdate = undefined;
        entry!.lastTurnAt = Date.now();
        this.resetIdleTimer(entry!);
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
    // ACP child's session state. Default `/root/.cerase/workspace`
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

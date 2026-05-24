import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import pino from "pino";
import type { BridgeConfig, AgentConfig } from "./config.js";
import { PromptQueue } from "./prompt-queue.js";

// `level: silent` is honoured when CERASE_ACP_LOG_LEVEL is unset OR set
// to "silent". Tests set it to silent via vitest's setup; production
// startup (M5 src/index.ts) lifts it to "info".
const logger = pino({
  name: "cerase-acp.session-manager",
  level: process.env.CERASE_ACP_LOG_LEVEL ?? "info",
});

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
      entry!.onUpdate = onUpdate;
      this.resetIdleTimer(entry!);
      try {
        const response = await entry!.connection.prompt({
          sessionId: entry!.sessionId,
          prompt: [{ type: "text", text }],
        });
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
          entryRef?.onUpdate?.(params.update);
        },
        async requestPermission(_params: acp.RequestPermissionRequest) {
          // PoC: in-DM permission UI is forbidden (M2 UX rules). Auto-
          // cancel any permission request. The agent should never reach
          // here if opencode.json's permission block is correct; if it
          // does, surface a warning log so operators see it.
          logger.warn(
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

    const { sessionId } = await connection.newSession({
      cwd: process.cwd(),
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

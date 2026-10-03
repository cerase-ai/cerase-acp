import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeLogger } from "./logger.js";

const logger = makeLogger("cerase-acp.resumable-sessions");

export const RESUMABLE_SESSIONS_FILE = "resumable-sessions.json";

/** One line of the file: a pair and the opencode session it talks through. */
interface StoredSession {
  pair: string;
  session: string;
}

/**
 * The opencode session each (agent, user) pair is talking through, kept so the
 * next child for the pair loads it instead of starting the conversation over.
 *
 * A slot restart is survived in memory alone, because the bridge outlives it.
 * A bridge restart is not: the process holding the map is the thing that went
 * away. So the map is written to the bridge's state directory on every change,
 * and a new bridge starts from what the old one wrote. opencode keeps the
 * sessions themselves in its own database on the slot's volume; this file
 * holds only which one each pair was in.
 *
 * The order is least-recently-used first, on disk as in memory, so a bridge
 * that starts from the file drops the same pairs first that the one before it
 * would have.
 *
 * Without a directory the map lives in memory only, which is what the CLI and
 * the tests that do not pass one get.
 */
export class ResumableSessions {
  private readonly ids = new Map<string, string>();

  constructor(
    private readonly dir: string | undefined,
    private readonly max: number,
  ) {
    for (const { pair, session } of this.read()) this.ids.set(pair, session);
    this.trim();
  }

  get(pair: string): string | undefined {
    return this.ids.get(pair);
  }

  get size(): number {
    return this.ids.size;
  }

  /**
   * Record the session a pair is in. Re-inserting moves the pair to the end,
   * which makes the bound least-recently-used rather than first-ever-seen: the
   * pair that talked most recently is the one most likely to talk again.
   */
  remember(pair: string, session: string): void {
    if (!session) return;
    const last = [...this.ids.keys()].pop();
    if (last === pair && this.ids.get(pair) === session) return;
    this.ids.delete(pair);
    this.ids.set(pair, session);
    this.trim();
    this.persist();
  }

  /**
   * Forget the pair's session, when it is still `session`: a later session of
   * the same pair is a different conversation and keeps its place.
   */
  forget(pair: string, session: string): void {
    if (this.ids.get(pair) !== session) return;
    this.ids.delete(pair);
    this.persist();
  }

  private trim(): void {
    while (this.ids.size > this.max) {
      const oldest = this.ids.keys().next();
      if (oldest.done) break;
      this.ids.delete(oldest.value);
    }
  }

  /**
   * Replace the file with the map, through a temporary file and a rename, so a
   * bridge killed in the middle of a write leaves the previous file whole. A
   * write that fails keeps the map in memory: the bridge goes on resuming
   * sessions across slot restarts, and only a restart of its own is lost.
   */
  private persist(): void {
    if (!this.dir) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const sessions: StoredSession[] = [...this.ids].map(([pair, session]) => ({ pair, session }));
      const tmp = join(this.dir, `${RESUMABLE_SESSIONS_FILE}.tmp`);
      writeFileSync(tmp, JSON.stringify({ sessions }), { mode: 0o600 });
      renameSync(tmp, join(this.dir, RESUMABLE_SESSIONS_FILE));
    } catch (err) {
      logger.warn(
        { reason: (err as Error).message },
        "the sessions to resume were not written to the state directory; kept in memory",
      );
    }
  }

  /**
   * The file as the previous bridge left it. A file that cannot be read or
   * parsed is a bridge that starts every conversation over, logged, and never
   * a bridge that does not start; the next write replaces it.
   */
  private read(): StoredSession[] {
    if (!this.dir) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(this.dir, RESUMABLE_SESSIONS_FILE), "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(
          { reason: (err as Error).message },
          "the sessions to resume could not be read; every conversation starts over and the file is replaced on the next write",
        );
      }
      return [];
    }
    const sessions = (parsed as { sessions?: unknown } | null)?.sessions;
    if (!Array.isArray(sessions)) {
      logger.warn("the sessions file holds no list of sessions; it is ignored and replaced on the next write");
      return [];
    }
    const out: StoredSession[] = [];
    for (const entry of sessions) {
      const { pair, session } = (entry ?? {}) as { pair?: unknown; session?: unknown };
      if (typeof pair === "string" && typeof session === "string" && session.length > 0) out.push({ pair, session });
    }
    logger.info({ sessions: out.length }, "sessions to resume read from the state directory");
    return out;
  }
}

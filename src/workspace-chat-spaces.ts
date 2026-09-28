import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeLogger } from "./logger.js";

const logger = makeLogger("cerase-acp.workspace-chat");
const FILE = "workspace-chat-spaces.json";

/** What the file holds: per Chat app, by project number, each person's space. */
type Stored = Record<string, Record<string, string>>;

/**
 * The direct-message space each person last wrote to one Chat app from.
 *
 * A message no event of theirs opened — a scheduled message, a platform notice,
 * a reply after the bridge restarted — needs a space to be posted in. Asking
 * Google for it by email is refused to a service account, so the space an
 * event arrived from is kept, on disk when the bridge has somewhere to write,
 * so a restart does not forget it.
 *
 * The space belongs to the app as much as to the person. Every assistant is its
 * own Chat app, and one person with two assistants has two direct-message
 * spaces, one per app; an app posting into the other's is refused as not a
 * member. So an entry is keyed by the app's project number — the app's own
 * identity, which a slot or an agent id is not, since either can be
 * reassigned — and then by the person.
 *
 * Every adapter keeps its own instance and all of them share one file. A write
 * therefore reads the file, changes the one entry it is about and writes the
 * result back, instead of writing out what this instance happens to hold:
 * that would drop whatever another app recorded since this one last read.
 */
export class WorkspaceChatSpaces {
  private readonly spaces = new Map<string, string>();

  constructor(
    private readonly dir: string | undefined,
    private readonly app: string,
  ) {
    if (!dir) return;
    for (const [user, space] of Object.entries(this.read()[app] ?? {})) this.spaces.set(user, space);
  }

  known(userId: string): string | undefined {
    return this.spaces.get(userId);
  }

  remember(userId: string, space: string | undefined): void {
    if (!space || this.spaces.get(userId) === space) return;
    this.spaces.set(userId, space);
    this.persist((mine) => {
      mine[userId] = space;
    });
  }

  /** Drop the entry for `userId`, when it is still `space`. */
  forget(userId: string, space: string): void {
    if (this.spaces.get(userId) !== space) return;
    this.spaces.delete(userId);
    this.persist((mine) => {
      if (mine[userId] === space) delete mine[userId];
    });
  }

  private persist(change: (mine: Record<string, string>) => void): void {
    if (!this.dir) return;
    try {
      const stored = this.read();
      const mine = { ...(stored[this.app] ?? {}) };
      change(mine);
      stored[this.app] = mine;
      mkdirSync(this.dir, { recursive: true });
      const tmp = join(this.dir, `${FILE}.tmp`);
      writeFileSync(tmp, JSON.stringify({ by_app: stored }), { mode: 0o600 });
      renameSync(tmp, join(this.dir, FILE));
    } catch (err) {
      logger.warn({ reason: (err as Error).message }, "workspace-chat space not persisted; kept in memory");
    }
  }

  /**
   * Every app's entries as the file holds them now.
   *
   * A file in the earlier shape, one space per person with no app, cannot say
   * which app a space belongs to: with two assistants it held whichever app
   * wrote last, and the other app's messages were refused in it. It is read as
   * empty, and the next write replaces it.
   */
  private read(): Stored {
    if (!this.dir) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(this.dir, FILE), "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn({ reason: (err as Error).message }, "workspace-chat spaces file unreadable, starting empty");
      }
      return {};
    }
    const byApp = (parsed as { by_app?: unknown } | null)?.by_app;
    if (typeof byApp !== "object" || byApp === null) {
      logger.info("workspace-chat spaces file has no per-app entries; it is ignored and replaced on the next write");
      return {};
    }
    const out: Stored = {};
    for (const [app, entries] of Object.entries(byApp)) {
      if (typeof entries !== "object" || entries === null) continue;
      const kept: Record<string, string> = {};
      for (const [user, space] of Object.entries(entries)) {
        if (typeof space === "string") kept[user] = space;
      }
      out[app] = kept;
    }
    return out;
  }
}

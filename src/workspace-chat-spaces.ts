import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeLogger } from "./logger.js";

const logger = makeLogger("cerase-acp.workspace-chat");
const FILE = "workspace-chat-spaces.json";

/**
 * The direct-message space each person last wrote to the app from.
 *
 * A message no event of theirs opened — a scheduled message, a platform notice,
 * a reply after the bridge restarted — needs a space to be posted in. Asking
 * Google for it by email is refused to a service account, so the space an
 * event arrived from is kept, on disk when the bridge has somewhere to write,
 * so a restart does not forget it.
 */
export class WorkspaceChatSpaces {
  private readonly spaces = new Map<string, string>();

  constructor(private readonly dir: string | undefined) {
    if (!dir) return;
    try {
      const stored = JSON.parse(readFileSync(join(dir, FILE), "utf8")) as Record<string, unknown>;
      for (const [user, space] of Object.entries(stored)) {
        if (typeof space === "string") this.spaces.set(user, space);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn({ reason: (err as Error).message }, "workspace-chat spaces file unreadable, starting empty");
      }
    }
  }

  known(userId: string): string | undefined {
    return this.spaces.get(userId);
  }

  remember(userId: string, space: string | undefined): void {
    if (!space || this.spaces.get(userId) === space) return;
    this.spaces.set(userId, space);
    if (!this.dir) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = join(this.dir, `${FILE}.tmp`);
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.spaces)), { mode: 0o600 });
      renameSync(tmp, join(this.dir, FILE));
    } catch (err) {
      logger.warn({ reason: (err as Error).message }, "workspace-chat space not persisted; kept in memory");
    }
  }
}

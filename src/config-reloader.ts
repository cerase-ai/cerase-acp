import { watch, type FSWatcher } from "node:fs";
import { makeLogger } from "./logger.js";
import { loadConfig, type BridgeConfig } from "./config.js";

const logger = makeLogger("cerase-acp.config-reloader");

export interface ConfigReloaderOptions {
  /** Debounce window for coalescing rapid writes (default 50ms). */
  debounceMs?: number;
  /** Env source for `${env:VAR}` substitution (default process.env). */
  env?: Record<string, string | undefined>;
}

/**
 * Watches `agents.yaml` on disk and fires `onChange(cfg)` after each
 * successful reload. Three guarantees the bridge relies on:
 *
 *  1. **Debounced** — many editors (and our own Symfony YAML writer)
 *     write through tmp + rename, producing a burst of fs events.
 *     Coalesce them into one onChange so the diff handler doesn't
 *     fire 4× per save.
 *  2. **Crash-tolerant** — a malformed YAML write (mid-edit, atomic
 *     rename in progress, schema violation) does NOT crash the
 *     bridge. We log a `error` line and skip the change. The next
 *     valid write recovers.
 *  3. **Stop-clean** — `stop()` detaches the watcher idempotently
 *     so the bridge shutdown path doesn't leave a stuck inotify fd.
 */
export class ConfigReloader {
  private watcher: FSWatcher | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private path: string,
    private onChange: (cfg: BridgeConfig) => void,
    private options: ConfigReloaderOptions = {},
  ) {}

  start(): void {
    if (this.watcher) return;
    this.stopped = false;
    const debounceMs = this.options.debounceMs ?? 50;
    try {
      this.watcher = watch(this.path, { persistent: false }, () => {
        if (this.stopped) return;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.tryReload(), debounceMs);
      });
    } catch (err) {
      logger.error({ err, path: this.path }, "ConfigReloader: fs.watch failed");
      throw err;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // already closed
      }
      this.watcher = undefined;
    }
  }

  private tryReload(): void {
    if (this.stopped) return;
    let cfg: BridgeConfig;
    try {
      cfg = loadConfig(this.path, this.options.env ?? process.env);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), path: this.path },
        "ConfigReloader: skip — invalid YAML / schema (will retry on next change)",
      );
      return;
    }
    try {
      this.onChange(cfg);
    } catch (err) {
      logger.error({ err }, "ConfigReloader: onChange handler threw");
    }
  }
}

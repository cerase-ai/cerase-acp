import type { AgentConfig, BridgeConfig } from "./config.js";

/**
 * Classifies the field set that changed on a single Agent between two
 * BridgeConfig snapshots:
 *
 *  - `allowed_users_only`  — only allowed_users mutated; the
 *                            ConfigReloader can swap the allowlist
 *                            in-place without restarting the Discord
 *                            adapter or killing ACP child processes.
 *  - `bot_token_or_spawn`  — bot_token, spawn.command, spawn.args, or
 *                            cwd changed; the Discord adapter must be
 *                            torn down + recreated and the agent's
 *                            ACP children must be killed (workspace +
 *                            transcripts persist in named volumes, so
 *                            users see at most a slower first reply).
 *  - `mixed`               — both classes of fields mutated in one
 *                            diff; the reloader treats this as
 *                            `bot_token_or_spawn` (superset).
 */
export type ModifiedClassification =
  | "allowed_users_only"
  | "bot_token_or_spawn"
  | "mixed";

export interface ModifiedAgent {
  agentId: string;
  classification: ModifiedClassification;
}

export interface ConfigDiff {
  added: AgentConfig[];
  removed: string[];
  modified: ModifiedAgent[];
}

/**
 * Pure function — does NOT mutate either input. Used by the
 * ConfigReloader (M-auto-reload) to decide the minimum-blast action
 * for each Agent when `agents.yaml` changes on disk.
 *
 * `session` block changes are intentionally NOT diffed here — Cerase
 * regenerates the same session block every time, and live mutation of
 * the SessionManager's idle timeout is out of scope for v0.2.
 */
export function diffConfigs(prev: BridgeConfig, next: BridgeConfig): ConfigDiff {
  const prevById = new Map(prev.agents.map((a) => [a.id, a] as const));
  const nextById = new Map(next.agents.map((a) => [a.id, a] as const));

  const added: AgentConfig[] = [];
  const removed: string[] = [];
  const modified: ModifiedAgent[] = [];

  for (const [id, agent] of nextById) {
    const before = prevById.get(id);
    if (!before) {
      added.push(agent);
      continue;
    }
    const classification = classifyMutation(before, agent);
    if (classification !== null) {
      modified.push({ agentId: id, classification });
    }
  }

  for (const id of prevById.keys()) {
    if (!nextById.has(id)) removed.push(id);
  }

  return { added, removed, modified };
}

function classifyMutation(prev: AgentConfig, next: AgentConfig): ModifiedClassification | null {
  const allowedUsersChanged = !setsEqual(prev.allowed_users, next.allowed_users);
  const respawnFieldsChanged =
    prev.bot_token !== next.bot_token ||
    prev.cwd !== next.cwd ||
    prev.spawn.command !== next.spawn.command ||
    !arraysEqual(prev.spawn.args, next.spawn.args);

  if (allowedUsersChanged && respawnFieldsChanged) return "mixed";
  if (respawnFieldsChanged) return "bot_token_or_spawn";
  if (allowedUsersChanged) return "allowed_users_only";
  return null;
}

function setsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const aset = new Set(a);
  for (const x of b) if (!aset.has(x)) return false;
  return true;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

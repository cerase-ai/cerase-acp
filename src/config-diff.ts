import type { AgentConfig, BridgeConfig } from "./config.js";

/**
 * Classifies the field set that changed on a single Agent between two
 * BridgeConfig snapshots:
 *
 *  - `allowed_users_only`  — only allowed_users mutated; the reload
 *                            swaps the allowlist in place without
 *                            restarting the agent's adapter or killing
 *                            its ACP children.
 *  - `bot_token_or_spawn`  — channel, bot_token, slack_app_token,
 *                            spawn.command, spawn.args, cwd, mode, model or
 *                            the assistant's Workspace Chat app changed; the
 *                            adapter is stopped and a new one started, and
 *                            the agent's ACP children are killed (a session
 *                            is resumed by id, so the person sees at most a
 *                            slower first reply).
 *  - `mixed`               — both classes of fields mutated in one
 *                            diff; the reloader treats this as
 *                            `bot_token_or_spawn` (superset).
 */
export type ModifiedClassification = "allowed_users_only" | "bot_token_or_spawn" | "mixed";

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
 * Pure function — does NOT mutate either input. The bridge's reload uses it
 * to decide the least disruptive action for each agent when `agents.yaml`
 * changes on disk.
 *
 * Only agents are compared. The top-level keys (`session`, `locale`,
 * `max_file_mb`) are applied on every reload whether they changed or not,
 * by the bridge and by loadConfig.
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
    // An adapter is made for one channel, from that channel's credentials:
    // createChatAdapter picks the transport by `channel`, and Slack's Socket
    // Mode connects with the app token. Only a new adapter carries a change
    // to any of them.
    prev.channel !== next.channel ||
    prev.bot_token !== next.bot_token ||
    prev.slack_app_token !== next.slack_app_token ||
    prev.cwd !== next.cwd ||
    // The mode is chosen once per session, at the handshake. A live session
    // goes on running under the agent it was created with, so a changed mode
    // that did not respawn would take effect at some unpredictable later
    // moment — whenever that session happened to end.
    prev.mode !== next.mode ||
    // The model is set when a session is resumed, and at no other moment: a
    // live session goes on running on the model it had. Ending the sessions is
    // what makes a changed model reach the next message rather than whichever
    // one follows the session's eventual death.
    prev.model !== next.model ||
    prev.spawn.command !== next.spawn.command ||
    !arraysEqual(prev.spawn.args, next.spawn.args) ||
    // The agent's own Chat app. An adapter verifies events against its
    // project number and certificates and posts with its key to its API from
    // start() on, so any of them changing has to reach the adapter by
    // restarting it.
    !sameWorkspaceChatApp(prev.workspace_chat, next.workspace_chat);

  if (allowedUsersChanged && respawnFieldsChanged) return "mixed";
  if (respawnFieldsChanged) return "bot_token_or_spawn";
  if (allowedUsersChanged) return "allowed_users_only";
  return null;
}

function sameWorkspaceChatApp(a: AgentConfig["workspace_chat"], b: AgentConfig["workspace_chat"]): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.project_number === b.project_number &&
    a.credentials_path === b.credentials_path &&
    a.certificates_url === b.certificates_url &&
    a.api_root === b.api_root
  );
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

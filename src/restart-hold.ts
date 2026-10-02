// A turn that meets the assistant while its slot restarts.
//
// The platform restarts a slot for ordinary reasons: a new prompt, a new skill
// or a new connection rewrites the assistant's instructions, and a refreshed
// gateway token or an update recreates the container. Every `docker exec`
// child running in it dies with the container, so a turn in flight loses its
// ACP connection, and a turn that arrives while the container is down cannot
// start one. Neither is a failure of the person's request: the session comes
// back seconds later, resumed by id, and the request can simply go to it.
//
// So such a turn is held and sent again, as the person wrote it, once the
// session is back, and only a session that stays away past a bound is reported
// to the person, in words that say the assistant is restarting.
//
// What makes a lost connection a restart is evidence, never the error alone.
// The same "ACP connection closed" is what a child that crashed on its own
// produces, and holding that turn would turn a real failure into a silent
// wait. The evidence is either that the bridge closed the session itself, or
// that the slot's container stopped, is restarting, or started after the child
// was spawned. Without either, the turn fails as it always did.

import type { AgentConfig } from "./config.js";
import { dockerExec, type SlotExec } from "./opencode-rest.js";

/**
 * How long a turn waits for the assistant's session to come back.
 *
 * Read from the slots' own logs: over 30 restarts in six slots, opencode was
 * listening again a median of 3.3 s and at most 11.4 s after it was told to
 * stop, and the bridge's handshake with a restarted slot took 3.8 to 6.6 s. The
 * longest single restart measured is therefore back within about 18 s. Two
 * restarts of one slot 25 s apart, which a new connection produces, put the
 * session back 36 s after the first. A minute covers both with room, and a
 * person who has heard nothing for a minute is owed a word.
 */
export const RESTART_HOLD_MS = 60_000;

/**
 * How often a held turn tries the session again. A failed try costs one
 * `docker exec` that the daemon refuses at once and one `docker inspect`.
 */
export const RESTART_RETRY_MS = 2_000;

/**
 * How long the probe waits before looking at the container a second time. The
 * child's stream can end a moment before the daemon records the container as
 * stopped, so a first look that finds it running as before is not yet an
 * answer.
 */
export const SLOT_SETTLE_MS = 1_000;

/**
 * Whether this agent's slot stopped, is restarting, or started at or after
 * `since` (epoch ms). `false` means it ran throughout, or that nothing could
 * say: an agent whose spawn is not a `docker exec` into a slot has no slot to
 * ask about.
 */
export type SlotRestartProbe = (agent: AgentConfig, since: number) => Promise<boolean>;

/**
 * The slot container a spawn runs in, for the `docker exec [-i] <container> …`
 * shape every slot spawn has. `null` for any other command.
 */
export function slotContainerOf(spawn: AgentConfig["spawn"]): string | null {
  const command = spawn.command.split("/").pop();
  if (command !== "docker" || spawn.args[0] !== "exec") return null;
  const name = spawn.args.slice(1).find((a) => !a.startsWith("-"));
  return name !== undefined && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) ? name : null;
}

/**
 * Whether `docker inspect --format '{{json .State}}'` output says the
 * container is not the one that was running at `since`.
 */
export function stateRestartedSince(stateJson: string, since: number): boolean {
  let state: { Running?: unknown; Restarting?: unknown; StartedAt?: unknown };
  try {
    state = JSON.parse(stateJson);
  } catch {
    return false;
  }
  if (state === null || typeof state !== "object") return false;
  if (state.Restarting === true || state.Running !== true) return true;
  const started = typeof state.StartedAt === "string" ? Date.parse(state.StartedAt) : Number.NaN;
  return Number.isFinite(started) && started >= since;
}

/** The production probe: the container's state, read through the bridge's docker proxy. */
export function dockerSlotRestartProbe(
  exec: SlotExec = dockerExec,
  settleMs: number = SLOT_SETTLE_MS,
): SlotRestartProbe {
  return async (agent, since) => {
    const container = slotContainerOf(agent.spawn);
    if (container === null) return false;
    for (let look = 0; look < 2; look++) {
      if (look > 0) await new Promise((r) => setTimeout(r, settleMs));
      const { stdout, ok } = await exec(["inspect", "--format", "{{json .State}}", container], 5000);
      if (ok && stateRestartedSince(stdout.trim(), since)) return true;
    }
    return false;
  };
}

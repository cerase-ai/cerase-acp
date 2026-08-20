// Which session mode a new ACP session runs under, decided from the handshake
// rather than from the error the wrong request comes back with.
//
// opencode maps its primary agents to ACP session modes, and `opencode acp`
// exposes no flag to pick one, so selecting the mode is how the bridge gets
// the Cerase profile instead of opencode's built-in "You are opencode" agent.
// The mode exists only if the control-plane rendered it into the slot's
// opencode.json, which makes its absence a statement about that slot's
// configuration and not a transient fault.
//
// The handshake already answers the question. `session/new` and
// `session/load` both carry the modes the agent can operate in, and the
// protocol says a mode passed to `session/set_mode` must be one of them. So
// asking for an absent mode is a request whose answer is known before it is
// sent, and the only thing the round trip adds is an error to log.
//
// Two shapes carry the advertisement and both are legal. The spec's own
// `modes` object is one; a `configOptions` entry categorised as a mode
// selector is the other, and it is the one opencode 1.18.18 sends. A client
// that reads only `modes` is blind to every agent that does what opencode
// does, which is why both are read here.

/** The primary agent the control-plane renders into each slot's opencode.json. */
export const CERASE_SESSION_MODE = "cerase";

/**
 * The parts of a `session/new` or `session/load` response that say which
 * modes exist. Structurally typed rather than taken from the SDK: the two
 * responses do not share a type, and both fields are optional in each.
 */
export interface ModeAdvertisement {
  modes?: { availableModes?: unknown } | null;
  configOptions?: unknown;
}

/**
 * The mode ids the agent advertised, or `undefined` when it advertised no
 * mode system at all.
 *
 * The distinction is the whole point of the return type. An empty array means
 * the agent has modes and none of them is usable; `undefined` means the
 * question was never answered, and those two call for opposite behaviour.
 */
export function advertisedModeIds(res: ModeAdvertisement | null | undefined): string[] | undefined {
  if (!res || typeof res !== "object") return undefined;

  const fromModes = res.modes?.availableModes;
  if (Array.isArray(fromModes)) {
    return fromModes.map((m) => idOf(m, "id")).filter(isNonEmpty);
  }

  if (Array.isArray(res.configOptions)) {
    for (const option of res.configOptions) {
      if (!isRecord(option)) continue;
      if (option.category !== "mode") continue;
      const values = option.options;
      if (!Array.isArray(values)) continue;
      return flattenSelectValues(values);
    }
  }

  return undefined;
}

/**
 * What to do about the mode for a session that has just been created or
 * loaded.
 *
 * `select` the agent listed it, so the request will succeed.
 * `absent` the agent listed its modes and this is not one of them.
 * `unannounced` the agent said nothing about modes, so nothing is known.
 */
export type SessionModeDecision =
  | { outcome: "select"; mode: string; available: string[] }
  | { outcome: "absent"; mode: string; available: string[] }
  | { outcome: "unannounced"; mode: string };

export function decideSessionMode(
  res: ModeAdvertisement | null | undefined,
  mode: string = CERASE_SESSION_MODE,
): SessionModeDecision {
  const available = advertisedModeIds(res);
  if (available === undefined) return { outcome: "unannounced", mode };
  if (available.includes(mode)) return { outcome: "select", mode, available };
  return { outcome: "absent", mode, available };
}

/**
 * One agent whose slot does not offer the mode its assistant needs. Reported
 * per agent rather than per session because the mode comes from the slot's
 * rendered configuration: every session for that agent meets the same
 * absence, and a person fixes it once.
 */
export interface SessionModeUnavailable {
  agentId: string;
  /** The mode the bridge asked the slot for. */
  requested: string;
  /** The modes the slot does offer, so a reader can see what it was given. */
  available: string[];
  /** One line naming what a person has to do to bring the assistant back. */
  detail: string;
}

/**
 * The sentence an operator reads, in the log and on the status endpoint. One
 * builder so the two cannot describe the same slot differently.
 */
export function sessionModeUnavailableDetail(requested: string, available: string[]): string {
  const offered = available.length > 0 ? available.join(", ") : "none";
  return (
    `The agent slot for this assistant does not define the "${requested}" mode, so no session can run under the ` +
    `Cerase profile. Re-render the slot from the control-plane and the next message picks it up. ` +
    `Modes the slot offers: ${offered}.`
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isNonEmpty(v: string | undefined): v is string {
  return typeof v === "string" && v.length > 0;
}

function idOf(v: unknown, key: string): string | undefined {
  if (!isRecord(v)) return undefined;
  const id = v[key];
  return typeof id === "string" ? id : undefined;
}

/**
 * A select option list is either flat or grouped, and a grouped list holds
 * its values one level down. Reading only the flat shape would report a
 * grouped agent as offering no modes at all, which is the reading that gets
 * a healthy session refused.
 */
function flattenSelectValues(values: unknown[]): string[] {
  const out: string[] = [];
  for (const entry of values) {
    if (!isRecord(entry)) continue;
    if (Array.isArray(entry.options)) {
      for (const inner of entry.options) {
        const id = idOf(inner, "value");
        if (isNonEmpty(id)) out.push(id);
      }
      continue;
    }
    const id = idOf(entry, "value");
    if (isNonEmpty(id)) out.push(id);
  }
  return out;
}

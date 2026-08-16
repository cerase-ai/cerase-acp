// What the control-plane knows and the bridge needs in front of a turn: the
// organization's wall clock, and when this person last spoke to this assistant.
//
// Both were missing for the same reason. The clock does not exist at all — the
// assistant sees a date and no time of day, and the slot container sets no TZ,
// so late in the evening in Italy it believes it is still yesterday. The gap
// exists but only in memory: `TurnMetaTracker` keeps it in a Map, so restarting
// this process makes the next turn read `gap=first` to somebody who has been
// writing for months.
//
// Neither is fixed by remembering more here. The timezone belongs to the
// organization and the last-turn timestamp is already persisted on the
// control-plane side, indexed on exactly the pair being asked about. A second
// copy of either is a second thing that can disagree.
//
// COST. The timezone is cached for the whole process with a short refresh, so
// after the first turn the clock is free. The last-turn lookup runs only when
// the tracker has no state for a pair, which after a restart is once per
// conversation and never again.

export interface TurnContextOptions {
  controlPlaneUrl: string;
  internalSecret: string;
  fetchImpl?: typeof fetch;
}

export interface TurnContext {
  timezone: string;
  /** ISO 8601 with offset, as the organization reads the clock. */
  now: string;
  /** Epoch ms of the pair's last turn, or undefined when they have never spoken. */
  lastTurnAt?: number;
}

// Long enough that a chatty hour costs one request, short enough that an
// operator who fixes the timezone in Org Settings sees it take effect without
// restarting anything.
const TIMEZONE_TTL_MS = 5 * 60 * 1000;

let cachedTimezone: { value: string; at: number } | undefined;

/** For tests, and for anything that needs the next call to really ask. */
export function resetTurnContextCache(): void {
  cachedTimezone = undefined;
}

/**
 * Ask the control-plane for the clock and the pair's last turn.
 *
 * THROWS on anything that is not a 2xx, and the caller must treat a throw as
 * "no extra information" rather than as "they have never spoken". Those two are
 * the same value (`undefined`) and opposite meanings: rendering the second on a
 * failed request would reintroduce the exact false `gap=first` this closes.
 */
export async function fetchTurnContext(
  agentId: string,
  identity: { platform?: string; platformUserId?: string },
  opts: TurnContextOptions,
): Promise<TurnContext> {
  const f = opts.fetchImpl ?? fetch;
  const params = new URLSearchParams();
  if (identity.platform) params.set("platform", identity.platform);
  if (identity.platformUserId) params.set("platform_user_id", identity.platformUserId);

  const qs = params.toString();
  const url =
    `${opts.controlPlaneUrl.replace(/\/$/, "")}/api/internal/turn-context/${encodeURIComponent(agentId)}` +
    (qs ? `?${qs}` : "");

  const resp = await f(url, { headers: { Authorization: `Bearer ${opts.internalSecret}` } });
  if (!resp.ok) {
    throw new Error(`turn-context: HTTP ${resp.status}`);
  }

  const body = (await resp.json()) as { timezone?: string; now?: string; last_turn_at?: string | null };
  const timezone = body.timezone ?? "UTC";
  cachedTimezone = { value: timezone, at: Date.now() };

  const last = body.last_turn_at ? Date.parse(body.last_turn_at) : NaN;

  return {
    timezone,
    now: body.now ?? new Date().toISOString(),
    lastTurnAt: Number.isFinite(last) ? last : undefined,
  };
}

/** The cached timezone, or undefined when nothing has answered yet. */
export function cachedTimezoneIfFresh(now: number = Date.now()): string | undefined {
  if (!cachedTimezone) return undefined;
  return now - cachedTimezone.at < TIMEZONE_TTL_MS ? cachedTimezone.value : undefined;
}

/**
 * The wall clock as the organization reads it, from an instant and a zone.
 *
 * `en-CA` for the date because it is the one common locale that formats as
 * year-month-day, which sorts and cannot be read as month-first by an assistant
 * that has seen both conventions. The zone travels with the value so the reader
 * is never left to assume UTC.
 */
export function formatWallClock(at: number, timezone: string): string {
  try {
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(at);

    return `${date} ${time} ${timezone}`;
  } catch {
    // An unknown zone name reaches here rather than throwing mid-turn. A turn
    // that fails because somebody typed a timezone wrong in a settings form is
    // a worse outcome than a turn stamped in UTC.
    return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
}

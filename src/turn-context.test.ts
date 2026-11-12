import { beforeEach, describe, expect, it } from "vitest";
import { specTest } from "./test-support/spec-rows.js";
import { cachedTimezoneIfFresh, fetchTurnContext, formatWallClock, resetTurnContextCache } from "./turn-context.js";
import { TurnMetaTracker } from "./turn-meta.js";

const OPTS = { controlPlaneUrl: "http://cp:8000", internalSecret: "s3cret", bridgeSecret: "bridge-secret" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  resetTurnContextCache();
});

describe("fetchTurnContext", () => {
  it("carries the person's channel identity, or the last turn cannot be found", async () => {
    let seen = "";
    let seenBridge = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen = String(url);
      seenBridge = (init?.headers as Record<string, string> | undefined)?.["X-Cerase-Bridge-Secret"] ?? "";
      return jsonResponse({ timezone: "Europe/Rome", now: "2026-08-16T14:05:00+02:00", last_turn_at: null });
    }) as unknown as typeof fetch;

    await fetchTurnContext("agent-1", { platform: "discord", platformUserId: "12345" }, { ...OPTS, fetchImpl });

    expect(seen).toContain("/api/internal/turn-context/agent-1");
    expect(seen).toContain("platform=discord");
    expect(seen).toContain("platform_user_id=12345");
    expect(seen).toContain("notes=1");
    expect(seenBridge).toBe("bridge-secret");
  });

  it("reads the platform's notes, keeping only the strings that say something", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        timezone: "Europe/Rome",
        notes: ["reconnect Google Workspace", "", 42, null, { text: "not a string" }, "a second note"],
      })) as unknown as typeof fetch;

    const ctx = await fetchTurnContext("a", { platformUserId: "u" }, { ...OPTS, fetchImpl });

    expect(ctx.notes).toEqual(["reconnect Google Workspace", "a second note"]);
  });

  it("takes an answer with no notes, or notes that are not a list, as none", async () => {
    const noNotes = (async () => jsonResponse({ timezone: "Europe/Rome" })) as unknown as typeof fetch;
    const notAList = (async () => jsonResponse({ timezone: "Europe/Rome", notes: "one" })) as unknown as typeof fetch;

    const absent = await fetchTurnContext("a", { platformUserId: "u" }, { ...OPTS, fetchImpl: noNotes });
    const wrong = await fetchTurnContext("a", { platformUserId: "u" }, { ...OPTS, fetchImpl: notAList });

    expect(absent.notes).toEqual([]);
    expect(wrong.notes).toEqual([]);
  });

  it("reads the last turn as epoch ms", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        timezone: "Europe/Rome",
        now: "2026-08-16T14:05:00+02:00",
        last_turn_at: "2026-08-16T09:00:00+00:00",
      })) as unknown as typeof fetch;

    const ctx = await fetchTurnContext("a", { platformUserId: "u" }, { ...OPTS, fetchImpl });

    expect(ctx.lastTurnAt).toBe(Date.parse("2026-08-16T09:00:00Z"));
    expect(ctx.timezone).toBe("Europe/Rome");
  });

  it("throws on a non-2xx instead of reporting no previous turn", async () => {
    // The distinction this test exists for: `undefined` means "they have never
    // spoken", and a failed request must not be able to say that. Swallowing
    // the error here would reintroduce the false `gap=first` the whole
    // milestone is about, and it would do it only when the control-plane is
    // having a bad minute.
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

    await expect(fetchTurnContext("a", { platformUserId: "u" }, { ...OPTS, fetchImpl })).rejects.toThrow();
  });

  it("caches the timezone so a busy hour is one request", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse({ timezone: "Asia/Tokyo", now: "2026-08-16T21:05:00+09:00", last_turn_at: null });
    }) as unknown as typeof fetch;

    await fetchTurnContext("a", { platformUserId: "u" }, { ...OPTS, fetchImpl });

    expect(calls).toBe(1);
    expect(cachedTimezoneIfFresh()).toBe("Asia/Tokyo");
    // Well past the refresh window: the cache has to expire, or an operator who
    // fixes the timezone in the settings form never sees it take effect.
    expect(cachedTimezoneIfFresh(Date.now() + 10 * 60 * 1000)).toBeUndefined();
  });
});

describe("formatWallClock", () => {
  it("renders the organization's wall clock, not the machine's", () => {
    const at = Date.parse("2026-08-16T22:30:00Z");

    expect(formatWallClock(at, "Europe/Rome")).toBe("Monday 2026-08-17 00:30 Europe/Rome");
  });

  it("is the case the assistant used to get wrong", () => {
    // Late evening in Italy, and the container is UTC. Before this the
    // assistant read a date that was still yesterday, with no time of day to
    // notice it by.
    const at = Date.parse("2026-08-16T23:10:00Z");

    expect(formatWallClock(at, "Europe/Rome")).toContain("2026-08-17");
  });

  specTest("ACP-TURN-032", "names the zone's day of the week, not the machine's", (row) => {
    // In Europe/Rome it is already Wednesday just after midnight; UTC, and the
    // machine the bridge runs on, is still on Tuesday. The weekday has to come
    // from the organization's zone, the same as the date and the time.
    const instant = row.quoted("when")[0]!;
    const zone = row.quoted("when")[1]!;
    const at = Date.parse(instant);
    const clock = formatWallClock(at, zone);

    expect(clock).toBe("Wednesday 2026-10-14 00:30 Europe/Rome");

    const zoneWeekday = clock.startsWith("Wednesday");
    const observed = `the clock reads "${clock}", naming the ${zoneWeekday ? "zone's" : "machine's"} weekday and not the ${zoneWeekday ? "machine's" : "zone's"}`;
    expect(observed).toBe(row.expect);
  });

  specTest("ACP-TURN-033", "names every day of the week in English", (row) => {
    const zone = row.quoted("when")[0]!;
    const week: Array<[string, string]> = [
      ["2026-10-12T12:00:00Z", "Monday 2026-10-12 14:00 Europe/Rome"],
      ["2026-10-13T12:00:00Z", "Tuesday 2026-10-13 14:00 Europe/Rome"],
      ["2026-10-14T12:00:00Z", "Wednesday 2026-10-14 14:00 Europe/Rome"],
      ["2026-10-15T12:00:00Z", "Thursday 2026-10-15 14:00 Europe/Rome"],
      ["2026-10-16T12:00:00Z", "Friday 2026-10-16 14:00 Europe/Rome"],
      ["2026-10-17T12:00:00Z", "Saturday 2026-10-17 14:00 Europe/Rome"],
      ["2026-10-18T12:00:00Z", "Sunday 2026-10-18 14:00 Europe/Rome"],
    ];
    const englishWeekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

    const clocks: string[] = [];
    for (const [at, expected] of week) {
      const clock = formatWallClock(Date.parse(at), zone);
      clocks.push(clock);
      expect(clock).toBe(expected);
    }

    const expectedWeekdays = week.map(([, expected]) => expected.split(" ")[0] ?? "");
    const namesEach = clocks.every((clock, index) => clock.split(" ")[0] === expectedWeekdays[index]);
    const capitalised = clocks.every((clock) => {
      const weekday = clock.split(" ")[0] ?? "";
      return weekday === weekday.charAt(0).toUpperCase() + weekday.slice(1).toLowerCase();
    });
    const beforeTheRest = clocks.every((clock) => {
      const [weekday, date, time, zoneLabel] = clock.split(" ");
      return (
        weekday !== undefined &&
        englishWeekdays.includes(weekday) &&
        date !== undefined &&
        /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        time !== undefined &&
        /^\d{2}:\d{2}$/.test(time) &&
        zoneLabel === zone
      );
    });
    const observed = `each reads its ${namesEach && capitalised && beforeTheRest ? "English weekday name, capitalised," : "weekday name,"} before the date, the time and the zone`;
    expect(observed).toBe(row.expect);
  });

  it("falls back to UTC rather than failing a turn on a bad zone name", () => {
    expect(formatWallClock(Date.parse("2026-08-16T10:00:00Z"), "Not/AZone")).toContain("UTC");
  });

  specTest("ACP-TURN-034", "names the UTC weekday too when it falls back on a bad zone name", (row) => {
    const zone = row.quoted("when")[0]!;
    const clock = formatWallClock(Date.parse("2026-08-16T10:00:00Z"), zone);
    expect(clock).toBe("Sunday 2026-08-16 10:00 UTC");

    const zoneLabel = clock.split(" ").at(-1) ?? "";
    const utc = zoneLabel === "UTC";
    const observed = `the clock reads the ${utc ? "UTC" : "wrong"} weekday, the ${utc ? "UTC" : "wrong"} date and time, and "${zoneLabel}" instead of failing the turn`;
    expect(observed).toBe(row.expect);
  });

  it("never names a weekday in Italian", () => {
    const italianWeekdays = ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"];
    const clocks = [
      "2026-10-12T12:00:00Z",
      "2026-10-13T12:00:00Z",
      "2026-10-14T12:00:00Z",
      "2026-10-15T12:00:00Z",
      "2026-10-16T12:00:00Z",
      "2026-10-17T12:00:00Z",
      "2026-10-18T12:00:00Z",
    ].map((instant) => formatWallClock(Date.parse(instant), "Europe/Rome"));
    clocks.push(formatWallClock(Date.parse("2026-08-16T10:00:00Z"), "Not/AZone"));

    for (const clock of clocks) {
      for (const weekday of italianWeekdays) {
        expect(clock).not.toContain(weekday);
      }
    }
  });
});

describe("TurnMetaTracker.prefixWithContext", () => {
  it("stops reporting gap=first after a restart", async () => {
    // A fresh tracker is what the bridge has one second after a restart. The
    // person on the other end has been writing for months.
    const tracker = new TurnMetaTracker();
    const now = Date.parse("2026-08-16T12:00:00Z");
    const twoHoursEarlier = now - 2 * 60 * 60 * 1000;

    const block = await tracker.prefixWithContext("a", "u", "ciao", {
      resolveLastTurn: async () => twoHoursEarlier,
      now,
    });

    expect(block).toContain("gap=2h");
    expect(block).not.toContain("gap=first");
  });

  it("asks only once, because after the first turn the map knows", async () => {
    const tracker = new TurnMetaTracker();
    let asked = 0;
    const resolveLastTurn = async () => {
      asked++;
      return Date.parse("2026-08-16T10:00:00Z");
    };

    await tracker.prefixWithContext("a", "u", "one", { resolveLastTurn, now: Date.parse("2026-08-16T12:00:00Z") });
    await tracker.prefixWithContext("a", "u", "two", { resolveLastTurn, now: Date.parse("2026-08-16T12:01:00Z") });

    expect(asked).toBe(1);
  });

  it("still says first when they really have never spoken", async () => {
    const tracker = new TurnMetaTracker();

    const block = await tracker.prefixWithContext("a", "u", "hello", { resolveLastTurn: async () => undefined });

    expect(block).toContain("gap=first");
  });

  it("survives a resolver that throws, rather than failing the turn", async () => {
    const tracker = new TurnMetaTracker();

    const block = await tracker.prefixWithContext("a", "u", "hello", {
      resolveLastTurn: async () => {
        throw new Error("control-plane down");
      },
    });

    expect(block).toContain("gap=first");
  });

  it("ignores a last turn in the future instead of rendering it as 0s", async () => {
    // Two machines, two clocks. A negative gap formats as `0s`, which reads as
    // "you just wrote" to somebody who has been away for a week.
    const tracker = new TurnMetaTracker();
    const now = Date.parse("2026-08-16T12:00:00Z");

    const block = await tracker.prefixWithContext("a", "u", "hello", {
      resolveLastTurn: async () => now + 60 * 60 * 1000,
      now,
    });

    expect(block).toContain("gap=first");
  });

  it("carries the clock when it has one and stays silent when it does not", async () => {
    const tracker = new TurnMetaTracker();

    const withClock = await tracker.prefixWithContext("a", "u", "hello", {
      clock: "Monday 2026-08-17 00:30 Europe/Rome",
    });
    const withoutClock = await tracker.prefixWithContext("b", "u", "hello", {});

    expect(withClock).toContain("now=Monday 2026-08-17 00:30 Europe/Rome");
    expect(withoutClock).not.toContain("now=");
  });
});

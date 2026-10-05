// A bridge that is stopped, by the release that recreates its container, lets
// the turns in flight finish instead of killing them, keeps a message that
// arrives meanwhile for the next bridge, and tells the person whose turn was
// still running at the limit that an update interrupted it.
//
// The fixture child plays the slot. FAKE_PROMPT_LOG records every prompt the
// assistant was sent, across children and bridges, which is what says whether a
// message reached it once, twice, or never. FAKE_ECHO_PROMPT makes each answer
// carry the message it answers, and FAKE_ECHO_SESSION the session it ran in.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { untilChild } from "./__tests__/fake-clock.js";
import { type RunBridgeHandle, runBridge } from "./bridge.js";
import type { ChatAdapter, DeliveryResult } from "./chat-adapter.js";
import type { BridgeConfig } from "./config.js";
import { Dispatcher, pickErrorMessage } from "./dispatcher.js";
import {
  KEPT_MESSAGE_MAX_AGE_MS,
  PENDING_MESSAGES_FILE,
  type PendingMessage,
  PendingMessages,
  replayPending,
} from "./pending-messages.js";
import { keptMessagesExpiredNotice, restartOutlastedNotice, updateInterruptedNotice } from "./platform-notices.js";
import { SessionManager } from "./session-manager.js";
import { TurnMetaTracker } from "./turn-meta.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

// Italian enough for the language detector, so the notices are the Italian ones.
const MESSAGE = "Ciao, mi prepari il riassunto della presentazione che ti ho mandato questa mattina?";
const SECOND = "E poi mi dici anche quali sono le prossime scadenze del progetto, per favore?";
const THIRD = "Ultima cosa: chi partecipa alla riunione di giovedì con il cliente?";

let dir: string;
let promptLog: string;
let mgr: SessionManager | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-stop-"));
  promptLog = join(dir, "prompts.log");
});

afterEach(async () => {
  if (mgr) await mgr.shutdown();
  mgr = undefined;
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

/** How many prompts the assistant was sent that carry `text`. */
function timesSent(text: string): number {
  if (!existsSync(promptLog)) return 0;
  return readFileSync(promptLog, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .filter((line) => (JSON.parse(line) as string).includes(text)).length;
}

const joined = (sent: string[]) => sent.map((s) => s.replace(/ ⏎$/u, "")).join("");

function config(env: string[] = []): BridgeConfig {
  return {
    agents: [
      {
        id: "doc-qa",
        channel: "discord",
        cwd: "/home/agent/cerase/workspace",
        mode: "cerase",
        bot_token: "irrelevant",
        allowed_users: ["111", "222"],
        spawn: {
          command: "env",
          args: [
            "--",
            ...env,
            "FAKE_ECHO_PROMPT=1",
            "FAKE_LOAD_SESSION=1",
            `FAKE_PROMPT_LOG=${promptLog}`,
            "node",
            FAKE_CHILD,
          ],
        },
      },
    ],
    session: { idle_timeout_minutes: 60, max_concurrent: 16 },
  };
}

// A turn of about a second: six pieces, 150 ms apart.
const SLOW = ["FAKE_CHUNKS=6", "FAKE_DELAY_MS_PER_CHUNK=150"];

/** A dispatcher on a real session manager, keeping messages in the test's directory unless told not to. */
function dispatcher(env: string[], opts: { keep?: boolean; slotRestarted?: boolean } = {}) {
  const cfg = config(env);
  mgr = new SessionManager(cfg, undefined, { slotRestarted: async () => opts.slotRestarted ?? false });
  const m = mgr;
  const sent: string[] = [];
  const creditChecks: string[] = [];
  const d = new Dispatcher({
    config: cfg,
    sessionManager: m,
    turnMeta: new TurnMetaTracker(),
    creditCheck: async (agentId) => {
      creditChecks.push(agentId);
      return { exhausted: false };
    },
    resolveSendTarget: () => async (text) => {
      sent.push(text);
      return { ok: true };
    },
    pendingMessages: opts.keep === false ? undefined : new PendingMessages(dir),
  });
  const stop = (limitMs: number) => d.stop({ limitMs, noticeMs: 5_000, endSessions: () => m.shutdown() });
  return { d, m, sent, stop, creditChecks };
}

const kept = () => new PendingMessages(dir).list();

describe("a bridge that stops with a turn in flight", () => {
  it("waits for the turn and delivers its whole answer before it stops", async () => {
    const { d, sent, stop } = dispatcher(SLOW);
    const turn = d.handleMessage("doc-qa", "111", MESSAGE);
    await untilChild(() => expect(timesSent(MESSAGE)).toBe(1));

    const report = await stop(10_000);

    // Everything is already in the chat when the stop resolves: a stop that
    // did not wait would be ahead of the answer here.
    expect(joined(sent)).toContain(MESSAGE);
    expect(joined(sent)).not.toContain(updateInterruptedNotice("it"));
    expect(await turn).toEqual({ ok: true });
    expect(report).toMatchObject({ turnsAtStop: 1, turnsInterrupted: 0, turnsUnfinished: 0, messagesKept: 0 });
    expect(report.waitedMs).toBeGreaterThan(0);
  });

  it("keeps a message that arrives meanwhile, acknowledged at once, and never sends it to the assistant", async () => {
    const { d, m, sent, stop } = dispatcher(SLOW);
    const first = d.handleMessage("doc-qa", "111", MESSAGE);
    await untilChild(() => expect(timesSent(MESSAGE)).toBe(1));
    const stopped = stop(10_000);

    const second = await d.handleMessage("doc-qa", "222", SECOND);
    expect(second).toEqual({ ok: true });
    // Kept while the first turn is still running, not after it.
    expect(m.turnsInFlight("doc-qa")).toBe(1);
    expect(kept()).toMatchObject([{ agentId: "doc-qa", userId: "222", text: SECOND }]);

    const report = await stopped;
    expect(await first).toEqual({ ok: true });
    expect(timesSent(MESSAGE)).toBe(1);
    expect(timesSent(SECOND)).toBe(0);
    expect(joined(sent)).not.toContain(SECOND);
    expect(report.messagesKept).toBe(1);
  });

  it("keeps a message queued behind the turn in flight instead of starting it after", async () => {
    const { d, m, stop } = dispatcher(SLOW);
    const first = d.handleMessage("doc-qa", "111", MESSAGE);
    const second = d.handleMessage("doc-qa", "111", SECOND);
    await untilChild(() => {
      expect(timesSent(MESSAGE)).toBe(1);
      expect(m.turnsInFlight("doc-qa")).toBe(2);
    });

    const report = await stop(10_000);

    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(timesSent(MESSAGE)).toBe(1);
    expect(timesSent(SECOND)).toBe(0);
    expect(kept()).toMatchObject([{ userId: "111", text: SECOND }]);
    expect(report).toMatchObject({ turnsAtStop: 2, turnsInterrupted: 0, messagesKept: 1 });
  });

  it("keeps a message whose session was still starting, rather than sending it once it has", async () => {
    const { d, m, stop } = dispatcher(SLOW);
    const turn = d.handleMessage("doc-qa", "111", MESSAGE);
    // The child is being spawned and has no session yet.
    await vi.waitFor(
      () => {
        expect(m.turnsInFlight("doc-qa")).toBe(1);
        expect(m.currentSessionId("doc-qa", "111")).toBeUndefined();
      },
      { interval: 2 },
    );

    const report = await stop(10_000);

    expect(await turn).toEqual({ ok: true });
    expect(m.currentSessionId("doc-qa", "111")).toBeDefined();
    expect(timesSent(MESSAGE)).toBe(0);
    expect(kept()).toMatchObject([{ userId: "111", text: MESSAGE }]);
    expect(report).toMatchObject({ turnsAtStop: 1, turnsInterrupted: 0, messagesKept: 1 });
  });

  it("keeps one person's messages in the order they were sent", async () => {
    const { d, m, stop } = dispatcher(SLOW);
    void d.handleMessage("doc-qa", "111", MESSAGE);
    const queued = d.handleMessage("doc-qa", "111", SECOND);
    await untilChild(() => {
      expect(timesSent(MESSAGE)).toBe(1);
      expect(m.turnsInFlight("doc-qa")).toBe(2);
    });
    const stopped = stop(10_000);
    await d.handleMessage("doc-qa", "111", THIRD);
    await queued;
    await stopped;

    expect(kept().map((k) => k.text)).toEqual([SECOND, THIRD]);
  });

  it("keeps a message that arrives meanwhile without asking the control-plane anything for it", async () => {
    const { d, creditChecks, stop } = dispatcher(SLOW);
    const stopped = stop(10_000);
    expect(await d.handleMessage("doc-qa", "111", MESSAGE)).toEqual({ ok: true });
    await stopped;
    expect(creditChecks).toEqual([]);
    expect(kept()).toHaveLength(1);
  });

  it("asks the person to send again a message it has nowhere to keep", async () => {
    const { d, sent, stop } = dispatcher(SLOW, { keep: false });
    void d.handleMessage("doc-qa", "111", MESSAGE);
    await untilChild(() => expect(timesSent(MESSAGE)).toBe(1));
    const stopped = stop(10_000);

    const second = await d.handleMessage("doc-qa", "222", SECOND);
    await stopped;

    expect(second.ok).toBe(false);
    expect(sent).toContain(restartOutlastedNotice("it"));
    expect(timesSent(SECOND)).toBe(0);
  });
});

describe("a turn still running when the stop stops waiting", () => {
  for (const slotRestarted of [false, true]) {
    it(`ends with the update notice, once, and is neither kept nor sent again${slotRestarted ? ", though the slot restarted too" : ""}`, async () => {
      const { d, m, sent, stop } = dispatcher(["FAKE_HANG_PROMPT=1"], { slotRestarted });
      const turn = d.handleMessage("doc-qa", "111", MESSAGE);
      await untilChild(() => expect(timesSent(MESSAGE)).toBe(1));

      const started = Date.now();
      const report = await stop(300);

      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
      expect(report).toMatchObject({ turnsAtStop: 1, turnsInterrupted: 1, turnsUnfinished: 0, messagesKept: 0 });
      expect((await turn).ok).toBe(false);
      expect(sent).toEqual([updateInterruptedNotice("it")]);
      expect(sent).not.toContain(pickErrorMessage(MESSAGE));
      expect(kept()).toEqual([]);
      // A turn held through a restart would be sent again within a retry.
      await new Promise((r) => setTimeout(r, 300));
      expect(timesSent(MESSAGE)).toBe(1);
      expect(m.activeSessionCount()).toBe(0);
    });
  }
});

describe("the messages a stopping bridge keeps", () => {
  const message = (store: PendingMessages, userId: string, text: string, receivedAt = Date.now()): PendingMessage => {
    const m = store.keep({ agentId: "doc-qa", userId, text, receivedAt });
    if (!m) throw new Error("not kept");
    return m;
  };
  // None of these is old enough to be told about.
  const noneExpired = async () => {
    throw new Error("no kept message here is past the age limit");
  };
  const answered = () => {
    const calls: PendingMessage[] = [];
    const dispatch = async (m: PendingMessage): Promise<DeliveryResult> => {
      calls.push(m);
      return { ok: true };
    };
    return { calls, dispatch };
  };

  it("are each answered once, however many replays run at the same time", async () => {
    const store = new PendingMessages(dir);
    const ids = [message(store, "111", MESSAGE), message(store, "222", SECOND), message(store, "111", THIRD)].map(
      (m) => m.id,
    );
    const { calls, dispatch } = answered();

    const counts = await Promise.all([
      replayPending(store, "doc-qa", dispatch, () => false, noneExpired),
      replayPending(new PendingMessages(dir), "doc-qa", dispatch, () => false, noneExpired),
    ]);

    expect(counts[0]! + counts[1]!).toBe(3);
    expect(calls.map((m) => m.id).sort()).toEqual([...ids].sort());
    expect(store.list()).toEqual([]);
    expect(await replayPending(store, "doc-qa", dispatch, () => false, noneExpired)).toBe(0);
    expect(calls).toHaveLength(3);
  });

  it("are taken out of the file before they are dispatched", async () => {
    const store = new PendingMessages(dir);
    message(store, "111", MESSAGE);
    let onDiskDuringDispatch: PendingMessage[] | undefined;
    await replayPending(
      store,
      "doc-qa",
      async () => {
        onDiskDuringDispatch = new PendingMessages(dir).list();
        return { ok: true };
      },
      () => false,
      noneExpired,
    );
    expect(onDiskDuringDispatch).toEqual([]);
  });

  it("are answered in the order one person sent them, each after the turn before has ended", async () => {
    const store = new PendingMessages(dir);
    message(store, "111", MESSAGE);
    message(store, "111", SECOND);
    message(store, "222", THIRD);
    const events: string[] = [];
    await replayPending(
      store,
      "doc-qa",
      async (m) => {
        events.push(`start ${m.text}`);
        await new Promise((r) => setTimeout(r, m.text === MESSAGE ? 100 : 10));
        events.push(`end ${m.text}`);
        return { ok: true };
      },
      () => false,
      noneExpired,
    );
    expect(events.indexOf(`start ${SECOND}`)).toBeGreaterThan(events.indexOf(`end ${MESSAGE}`));
    // Another person does not wait for the first one's turn.
    expect(events.indexOf(`start ${THIRD}`)).toBeLessThan(events.indexOf(`end ${MESSAGE}`));
  });

  it("stay in the file, in order, when the bridge starts to stop while they wait their turn", async () => {
    const store = new PendingMessages(dir);
    message(store, "111", MESSAGE);
    message(store, "111", SECOND);
    let stopping = false;
    const { calls } = answered();
    await replayPending(
      store,
      "doc-qa",
      async (m) => {
        calls.push(m);
        stopping = true;
        return { ok: true };
      },
      () => stopping,
      noneExpired,
    );
    expect(calls.map((m) => m.text)).toEqual([MESSAGE]);
    expect(store.list().map((m) => m.text)).toEqual([SECOND]);
  });

  it.skipIf(process.getuid?.() === 0)("are not answered when they cannot be taken out of the file", async () => {
    const store = new PendingMessages(dir);
    message(store, "111", MESSAGE);
    chmodSync(dir, 0o500);
    const { calls, dispatch } = answered();
    expect(await replayPending(store, "doc-qa", dispatch, () => false, noneExpired)).toBe(0);
    expect(calls).toEqual([]);
    expect(store.list().map((m) => m.text)).toEqual([MESSAGE]);
  });

  it("are left alone for another agent", async () => {
    const store = new PendingMessages(dir);
    store.keep({ agentId: "other", userId: "111", text: MESSAGE, receivedAt: Date.now() });
    const { calls, dispatch } = answered();
    expect(await replayPending(store, "doc-qa", dispatch, () => false, noneExpired)).toBe(0);
    expect(calls).toEqual([]);
    expect(store.list()).toHaveLength(1);
  });

  it("start as none from a file that cannot be read, and are kept again after it", () => {
    const store = new PendingMessages(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(store.list()).toEqual([]);
    // A file that is not JSON.
    message(store, "111", MESSAGE);
    const file = join(dir, PENDING_MESSAGES_FILE);
    writeFileSync(file, "{ not json");
    expect(store.list()).toEqual([]);
    message(store, "111", SECOND);
    expect(store.list().map((m) => m.text)).toEqual([SECOND]);
  });

  // A message kept across a restart is answered only while it is recent: an
  // instruction left while the box was down for hours can be one the person
  // no longer wants carried out. An older one is taken out of the file without
  // reaching the assistant, and its person is told, once for all of theirs.
  it("are answered only within the age limit, and the person is told once about the older ones", async () => {
    const store = new PendingMessages(dir);
    const old = Date.now() - KEPT_MESSAGE_MAX_AGE_MS - 60_000;
    message(store, "111", MESSAGE, old);
    message(store, "111", SECOND, old + 1_000);
    message(store, "111", THIRD, Date.now() - KEPT_MESSAGE_MAX_AGE_MS + 60_000);
    message(store, "222", MESSAGE, old);
    const events: string[] = [];
    const count = await replayPending(
      store,
      "doc-qa",
      async (m) => {
        events.push(`answer ${m.userId} ${m.text}`);
        return { ok: true };
      },
      () => false,
      async (userId, expired) => {
        events.push(`tell ${userId} ${expired.map((m) => m.text).join(" | ")}`);
      },
    );

    expect(count).toBe(1);
    expect(events.filter((e) => e.startsWith("answer"))).toEqual([`answer 111 ${THIRD}`]);
    // Told before the recent message is answered, so the chat reads in order.
    expect(events.filter((e) => e.includes(" 111 "))).toEqual([
      `tell 111 ${MESSAGE} | ${SECOND}`,
      `answer 111 ${THIRD}`,
    ]);
    expect(events).toContain(`tell 222 ${MESSAGE}`);
    expect(store.list()).toEqual([]);
  });

  it("are not told about twice when an old one cannot be taken out of the file", async () => {
    const store = new PendingMessages(dir);
    message(store, "111", MESSAGE, Date.now() - KEPT_MESSAGE_MAX_AGE_MS - 60_000);
    chmodSync(dir, 0o500);
    const told: string[] = [];
    await replayPending(
      store,
      "doc-qa",
      async () => ({ ok: true }),
      () => false,
      async (userId) => {
        told.push(userId);
      },
    );
    chmodSync(dir, 0o700);
    if (process.getuid?.() !== 0) expect(told).toEqual([]);
  });

  it("are not kept without a state directory", () => {
    expect(
      new PendingMessages(undefined).keep({ agentId: "doc-qa", userId: "111", text: MESSAGE, receivedAt: Date.now() }),
    ).toBeUndefined();
  });
});

describe("a restart of the whole bridge", () => {
  const handles: RunBridgeHandle[] = [];

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => h.shutdown()));
    vi.unstubAllEnvs();
  });

  /** One bridge process: its chat, its adapter's stop, and its dispatcher. */
  async function start(env: string[], drainMs: number) {
    vi.stubEnv("CERASE_ACP_STATE_DIR", dir);
    vi.stubEnv("CERASE_ACP_STOP_DRAIN_MS", String(drainMs));
    vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", "");
    const events: string[] = [];
    let dispatcherRef: Dispatcher | undefined;
    const handle = await runBridge({
      config: config(["FAKE_ECHO_SESSION=1", ...env]),
      bridgeE2eTest: false,
      createAdapter: async (agent, d): Promise<ChatAdapter> => {
        dispatcherRef = d;
        return {
          agentId: agent.id,
          async start() {},
          async stop() {
            events.push("stop");
          },
          makeSendTarget: () => async (chunk) => {
            events.push(chunk);
            return { ok: true };
          },
        };
      },
    });
    handles.push(handle);
    const chat = () => joined(events.filter((e) => e !== "stop"));
    return { handle, events, chat, dispatcher: () => dispatcherRef as Dispatcher };
  }

  /** The session the answer carrying `text` ran in: the last one named before it. */
  const sessionIn = (chat: string, text: string): string | undefined => {
    const before = chat.slice(0, chat.indexOf(text));
    return [...before.matchAll(/session=(fake-session-cwd=[^#]*#\d+)/g)].pop()?.[1];
  };

  it("finishes the turn in flight, and the next bridge answers the message kept meanwhile, once, in the same session", async () => {
    const old = await start(SLOW, 10_000);
    const first = old.dispatcher().handleMessage("doc-qa", "111", MESSAGE);
    await untilChild(() => expect(timesSent(MESSAGE)).toBe(1));

    const stopped = old.handle.shutdown();
    expect(await old.dispatcher().handleMessage("doc-qa", "111", SECOND)).toEqual({ ok: true });
    await stopped;

    expect(await first).toEqual({ ok: true });
    expect(old.chat()).toContain(MESSAGE);
    expect(old.chat()).not.toContain(SECOND);
    // The answer went out before the adapter stopped.
    expect(old.events.at(-1)).toBe("stop");
    const session = sessionIn(old.chat(), MESSAGE);
    expect(session).toBeDefined();

    const next = await start([], 10_000);
    await untilChild(() => expect(next.chat()).toContain(SECOND));
    expect(sessionIn(next.chat(), SECOND)).toBe(session);
    expect(timesSent(SECOND)).toBe(1);
    expect(new PendingMessages(dir).list()).toEqual([]);

    // A third bridge has nothing left to answer.
    await next.handle.shutdown();
    const third = await start([], 10_000);
    await new Promise((r) => setTimeout(r, 500));
    expect(third.chat()).toBe("");
    expect(timesSent(SECOND)).toBe(1);
    expect(timesSent(MESSAGE)).toBe(1);
  });

  it("tells the person a turn still running at the limit was interrupted, and the next bridge does not answer it again", async () => {
    const old = await start(["FAKE_HANG_PROMPT=1"], 300);
    const first = old.dispatcher().handleMessage("doc-qa", "111", MESSAGE);
    await untilChild(() => expect(timesSent(MESSAGE)).toBe(1));

    await old.handle.shutdown();

    expect((await first).ok).toBe(false);
    expect(old.events).toEqual([updateInterruptedNotice("it"), "stop"]);

    const next = await start([], 10_000);
    await new Promise((r) => setTimeout(r, 500));
    expect(next.chat()).toBe("");
    expect(timesSent(MESSAGE)).toBe(1);
  });

  it("does not answer a kept message older than the age limit, and tells the person it was not handled", async () => {
    new PendingMessages(dir).keep({
      agentId: "doc-qa",
      userId: "111",
      text: MESSAGE,
      receivedAt: Date.now() - KEPT_MESSAGE_MAX_AGE_MS - 60_000,
    });

    const next = await start([], 10_000);

    await untilChild(() => expect(next.chat()).toBe(keptMessagesExpiredNotice("it", 1)));
    expect(timesSent(MESSAGE)).toBe(0);
    expect(new PendingMessages(dir).list()).toEqual([]);
  });

  it("stops once when it is asked twice", async () => {
    const old = await start([], 10_000);
    await Promise.all([old.handle.shutdown(), old.handle.shutdown()]);
    expect(old.events).toEqual(["stop"]);
  });
});

// A turn whose model call is still open.
//
// opencode reads the whole prompt before it writes its first token, and over
// ACP it sends nothing until that token. On a large prompt that silence
// outlasts the watchdog's silence limit, and a watchdog that reads the quiet
// as a hung child kills the call before it answers. The watchdog asks the slot
// for the session's newest message instead, and spares the turn while an
// assistant message with no `time.completed` and no `error` is in flight, up to
// a limit of its own and never past the turn's ceiling.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { untilChild, useBridgeClock } from "./__tests__/fake-clock.js";
import type { AgentConfig, BridgeConfig } from "./config.js";
import { SessionManager, type SessionUpdateHandler } from "./session-manager.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));
const SILENCE_MS = 180_000;

type OpenCall = { messageId: string; summary: boolean };

function config(env: string[], session: Record<string, unknown> = {}): BridgeConfig {
  return {
    agents: [
      {
        id: "doc-qa",
        channel: "discord",
        bot_token: "irrelevant-for-acp-tests",
        allowed_users: ["111"],
        cwd: "/home/agent/cerase/workspace",
        mode: "cerase",
        spawn: { command: "env", args: ["--", ...env, "node", FAKE_CHILD] },
      },
    ],
    session: { idle_timeout_minutes: 60, max_concurrent: 16, ...session } as BridgeConfig["session"],
  };
}

/** A turn's outcome, readable while it is still running. */
function watch(turn: Promise<unknown>) {
  const state: { settled: boolean; error?: unknown; value?: unknown } = { settled: false };
  const done = turn.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error: unknown) => Object.assign(state, { settled: true, error }),
  );
  return { state, done };
}

describe("a turn whose model call is still open", () => {
  let dir: string;
  let m: SessionManager | undefined;
  let asked: [string, string][];
  // What the slot answers when asked which model call the session has open.
  let open: () => OpenCall | null;
  const probe = async (agent: AgentConfig, sessionId: string) => {
    asked.push([agent.id, sessionId]);
    return open();
  };

  beforeEach(() => {
    useBridgeClock();
    dir = mkdtempSync(join(tmpdir(), "session-model-call-"));
    asked = [];
    open = () => null;
  });

  afterEach(async () => {
    await m?.shutdown();
    m = undefined;
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a turn whose model call is still open past the silence limit, and its answer reaches the person", async () => {
    const release = join(dir, "answered");
    open = () => (existsSync(release) ? null : { messageId: "msg_reply", summary: false });
    m = new SessionManager(
      config([`FAKE_SILENT_UNTIL_FILE=${release}`, "FAKE_MESSAGE_ID=msg_reply", "FAKE_REPLY=ecco la risposta"]),
      undefined,
      { openCallProbe: probe, endpointResolver: () => null },
    );
    const mm = m;
    const compacting: boolean[] = [];
    const texts: string[] = [];
    const onUpdate: SessionUpdateHandler = (u) => {
      if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") texts.push(u.content.text);
    };
    const turn = watch(mm.prompt("doc-qa", "111", "ciao", onUpdate, { onCompaction: (on) => compacting.push(on) }));
    await untilChild(() => expect(mm.activeSessionCount()).toBe(1));

    await vi.advanceTimersByTimeAsync(2 * SILENCE_MS);
    expect(turn.state.settled).toBe(false);
    expect(compacting).toEqual([]);
    expect(asked.length).toBeGreaterThan(0);

    writeFileSync(release, "");
    await turn.done;
    expect(turn.state.value).toMatchObject({ stopReason: "end_turn" });
    expect(texts.join("")).toContain("ecco la risposta");
    expect(compacting).toEqual([]);
  });

  it("kills a silent child with no open model call at the silence limit", async () => {
    m = new SessionManager(config(["FAKE_HANG_PROMPT=1"]), undefined, { openCallProbe: probe });
    const mm = m;
    const turn = watch(mm.prompt("doc-qa", "111", "ciao"));
    await untilChild(() => expect(mm.activeSessionCount()).toBe(1));

    await vi.advanceTimersByTimeAsync(SILENCE_MS - 10_000);
    expect(turn.state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    await turn.done;
    expect(turn.state.error).toMatchObject({ name: "TurnWatchdogError", reason: "silent", ms: SILENCE_MS });
    expect(asked.length).toBeGreaterThan(0);
  });

  it("ends a model call that stays silent past the model-call limit", async () => {
    open = () => ({ messageId: "msg_reply", summary: false });
    m = new SessionManager(config(["FAKE_HANG_PROMPT=1"]), undefined, {
      openCallProbe: probe,
      turnModelWaitMs: 600_000,
    });
    const mm = m;
    const turn = watch(mm.prompt("doc-qa", "111", "ciao"));
    await untilChild(() => expect(mm.activeSessionCount()).toBe(1));

    await vi.advanceTimersByTimeAsync(600_000 - 30_000);
    expect(turn.state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(40_000);
    await turn.done;
    expect(turn.state.error).toMatchObject({ name: "TurnWatchdogError", reason: "silent", ms: 600_000 });
  });

  it("still ends a turn waiting on an open model call at the turn's ceiling", async () => {
    open = () => ({ messageId: "msg_reply", summary: false });
    m = new SessionManager(config(["FAKE_HANG_PROMPT=1"]), undefined, {
      openCallProbe: probe,
      turnModelWaitMs: 900_000,
      turnCeilingMs: 400_000,
    });
    const mm = m;
    const turn = watch(mm.prompt("doc-qa", "111", "ciao"));
    await untilChild(() => expect(mm.activeSessionCount()).toBe(1));

    await vi.advanceTimersByTimeAsync(390_000);
    expect(turn.state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    await turn.done;
    expect(turn.state.error).toMatchObject({ name: "TurnWatchdogError", reason: "ceiling" });
  });

  it("reads the model-call limit from agents.yaml, defaults it to 900 s, and takes a reloaded one", async () => {
    m = new SessionManager(config([], { turn_model_wait_seconds: 420 }), undefined, { openCallProbe: probe });
    const limits = (mm: SessionManager) => mm.sessionLimits() as { turn_model_wait_seconds?: number };
    expect(limits(m).turn_model_wait_seconds).toBe(420);

    const session = {
      ...config([], { turn_model_wait_seconds: 420 }).session,
      turn_model_wait_seconds: 600,
    } as BridgeConfig["session"];
    m.applySession(session);
    expect(limits(m).turn_model_wait_seconds).toBe(600);

    const defaulted = new SessionManager(config([]), undefined, { openCallProbe: probe });
    expect(limits(defaulted).turn_model_wait_seconds).toBe(900);
    await defaulted.shutdown();
    await m.shutdown();

    open = () => ({ messageId: "msg_reply", summary: false });
    m = new SessionManager(config(["FAKE_HANG_PROMPT=1"], { turn_model_wait_seconds: 420 }), undefined, {
      openCallProbe: probe,
    });
    const mm = m;
    const turn = watch(mm.prompt("doc-qa", "111", "ciao"));
    await untilChild(() => expect(mm.activeSessionCount()).toBe(1));

    await vi.advanceTimersByTimeAsync(410_000);
    expect(turn.state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    await turn.done;
    expect(turn.state.error).toMatchObject({ name: "TurnWatchdogError", reason: "silent", ms: 420_000 });
  });
});

// A turn whose session is writing the summary of its history.
//
// opencode summarises a session in a model call that reads the whole
// conversation before it writes a word, and over ACP it sends nothing until
// that first word. On a long conversation that call outlasts the silence
// limit, and a watchdog that reads the quiet as a hung child kills it before
// the summary is written, so the next message starts the summary over. The
// watchdog asks the slot instead, and spares the turn while the session is
// summarising, up to a bound of its own; a turn that is silent for any other
// reason is still ended at the silence limit.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { untilChild, useBridgeClock } from "./__tests__/fake-clock.js";
import type { AgentConfig, BridgeConfig } from "./config.js";
import { COMPACTION_SILENCE_MS, SessionManager, type SessionUpdateHandler } from "./session-manager.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));
const SILENCE_MS = 180_000;

function config(env: string[]): BridgeConfig {
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
    session: { idle_timeout_minutes: 60, max_concurrent: 16 },
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

describe("a turn whose session is summarising its history", () => {
  let dir: string;
  let m: SessionManager | undefined;
  let asked: [string, string][];
  // What the slot answers when asked which summary the session is writing.
  let writing: string | null;
  const probe = async (agent: AgentConfig, sessionId: string) => {
    asked.push([agent.id, sessionId]);
    return writing;
  };

  beforeEach(() => {
    useBridgeClock();
    dir = mkdtempSync(join(tmpdir(), "session-compaction-"));
    asked = [];
    writing = null;
  });

  afterEach(async () => {
    await m?.shutdown();
    m = undefined;
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is not killed while the session writes its summary past the silence limit, and is told when it starts and ends", async () => {
    const release = join(dir, "summary-written");
    writing = "msg_summary";
    m = new SessionManager(
      config([
        `FAKE_SUMMARY_UNTIL_FILE=${release}`,
        "FAKE_SUMMARY_ID=msg_summary",
        "FAKE_MESSAGE_ID=msg_reply",
        "FAKE_REPLY=ecco",
      ]),
      undefined,
      { compactionProbe: probe, endpointResolver: () => null },
    );
    const mm = m;
    const compacting: boolean[] = [];
    const texts: string[] = [];
    const onUpdate: SessionUpdateHandler = (u) => {
      if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") texts.push(u.content.text);
    };
    const turn = watch(mm.prompt("doc-qa", "111", "ciao", onUpdate, { onCompaction: (on) => compacting.push(on) }));
    await untilChild(() => expect(mm.activeSessionCount()).toBe(1));

    // Six minutes without a word, twice the silence limit: the summary of a
    // long conversation reads all of it before it writes anything.
    await vi.advanceTimersByTimeAsync(2 * SILENCE_MS);
    expect(turn.state.settled).toBe(false);
    expect(compacting).toEqual([true]);
    expect(asked[0]).toEqual(["doc-qa", mm.currentSessionId("doc-qa", "111")]);

    // The summary is written, and the answer that follows it ends the state.
    writeFileSync(release, "");
    await turn.done;
    expect(turn.state.value).toMatchObject({ stopReason: "end_turn" });
    expect(texts.join("")).toContain("ecco");
    expect(compacting).toEqual([true, false]);
  });

  it("is killed at the silence limit, as before, when the session is not summarising", async () => {
    m = new SessionManager(config(["FAKE_HANG_PROMPT=1"]), undefined, { compactionProbe: probe });
    const mm = m;
    const compacting: boolean[] = [];
    const turn = watch(mm.prompt("doc-qa", "111", "ciao", undefined, { onCompaction: (on) => compacting.push(on) }));
    await untilChild(() => expect(mm.activeSessionCount()).toBe(1));

    await vi.advanceTimersByTimeAsync(SILENCE_MS - 10_000);
    expect(turn.state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    await turn.done;
    expect(turn.state.error).toMatchObject({ name: "TurnWatchdogError", reason: "silent", ms: SILENCE_MS });
    // The kill was decided on an answer, not on the silence alone.
    expect(asked.length).toBeGreaterThan(0);
    expect(compacting).toEqual([]);
  });

  it("counts silence again once the slot no longer finds a summary under way", async () => {
    writing = "msg_summary";
    m = new SessionManager(config(["FAKE_HANG_PROMPT=1"]), undefined, { compactionProbe: probe });
    const mm = m;
    const compacting: boolean[] = [];
    const turn = watch(mm.prompt("doc-qa", "111", "ciao", undefined, { onCompaction: (on) => compacting.push(on) }));
    await untilChild(() => expect(mm.activeSessionCount()).toBe(1));

    await vi.advanceTimersByTimeAsync(SILENCE_MS + 60_000);
    expect(turn.state.settled).toBe(false);

    // The summary ended and nothing followed it: the child is silent now for
    // no reason the slot can name.
    writing = null;
    await vi.advanceTimersByTimeAsync(30_000);
    await turn.done;
    expect(turn.state.error).toMatchObject({ name: "TurnWatchdogError", reason: "silent", ms: SILENCE_MS });
    expect(compacting).toEqual([true, false]);
  });

  it("is ended when the summary stays silent past the longest a summary is allowed", async () => {
    writing = "msg_summary";
    m = new SessionManager(config(["FAKE_HANG_PROMPT=1"]), undefined, { compactionProbe: probe });
    const mm = m;
    const turn = watch(mm.prompt("doc-qa", "111", "ciao"));
    await untilChild(() => expect(mm.activeSessionCount()).toBe(1));

    await vi.advanceTimersByTimeAsync(COMPACTION_SILENCE_MS - 30_000);
    expect(turn.state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(40_000);
    await turn.done;
    expect(turn.state.error).toMatchObject({ name: "TurnWatchdogError", reason: "silent", ms: COMPACTION_SILENCE_MS });
  });
});

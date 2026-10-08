// A person's message that arrives after a summary was left unfinished.
//
// opencode 1.18.18 starts a summary by writing a user message holding a
// `compaction` part, and runs it as work owed by the next prompt for as long as
// no assistant message has finished after that marker. A summary stopped
// halfway (a slot restart, a provider error) leaves the marker owed, and the
// next prompt is the person's: the runtime writes the summary under the
// person's message, which holds no marker, so the summary cuts nothing and the
// message gets no answer of its own (`lt-name-1`, 8 October). The bridge reads
// the session before a person's message, has it summarise again under a marker
// of its own when one was left unfinished, waits for one being written, and
// only then sends the message.
//
// The message shapes below are opencode 1.18.18's, as `GET
// /session/{id}/message` serves them: an aborted summary carries an
// AbortedError and `time.completed` and no `finish`; one killed with its slot
// carries neither.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { untilChild, useBridgeClock } from "./__tests__/fake-clock.js";
import type { BridgeConfig } from "./config.js";
import { type SummaryState, summaryStateOf } from "./opencode-rest.js";
import {
  COMPACTION_PROBE_EVERY_MS,
  SessionManager,
  SUMMARY_COMMAND,
  SummaryNotSettledError,
} from "./session-manager.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

const user = (id: string, created: number, parts: { type: string }[] = [{ type: "text" }]) => ({
  info: { id, role: "user", time: { created } },
  parts,
});
const marker = (id: string, created: number) => user(id, created, [{ type: "compaction" }]);
const answer = (id: string, parentID: string, created: number) => ({
  info: { id, role: "assistant", parentID, finish: "stop", time: { created, completed: created + 1 } },
  parts: [{ type: "text" }],
});
const summary = (
  id: string,
  parentID: string,
  created: number,
  end: "finished" | "aborted" | "killed" | "running",
) => ({
  info: {
    id,
    role: "assistant",
    parentID,
    summary: true,
    mode: "compaction",
    agent: "compaction",
    time: end === "killed" || end === "running" ? { created } : { created, completed: created + 5 },
    ...(end === "finished" ? { finish: "stop" } : {}),
    ...(end === "aborted" ? { error: { name: "MessageAbortedError", data: { message: "Aborted" } } } : {}),
  },
  parts: end === "finished" ? [{ type: "text" }] : [],
});

describe("where a session stands with its summaries", () => {
  it("is settled after a finished answer, and after a summary finished under its marker", () => {
    expect(summaryStateOf([user("u1", 1), answer("a1", "u1", 2)], false)).toEqual({ kind: "settled" });
    expect(
      summaryStateOf(
        [user("u1", 1), answer("a1", "u1", 2), marker("c1", 3), summary("s1", "c1", 4, "finished")],
        false,
      ),
    ).toEqual({ kind: "settled" });
  });

  it("is stranded when the summary under the newest marker was aborted or killed with its slot", () => {
    for (const end of ["aborted", "killed"] as const) {
      expect(
        summaryStateOf([user("u1", 1), answer("a1", "u1", 2), marker("c1", 3), summary("s1", "c1", 4, end)], false),
      ).toEqual({ kind: "stranded", markerId: "c1" });
    }
  });

  it("is still stranded once a message the runtime has not answered follows the unfinished summary", () => {
    const failed = { info: { id: "a2", role: "assistant", parentID: "u2", time: { created: 6 } }, parts: [] };
    expect(
      summaryStateOf(
        [answer("a1", "u0", 2), marker("c1", 3), summary("s1", "c1", 4, "aborted"), user("u2", 5), failed],
        false,
      ),
    ).toEqual({ kind: "stranded", markerId: "c1" });
  });

  it("is being written while the slot's server works on the session, created or not yet", () => {
    expect(summaryStateOf([answer("a1", "u1", 2), marker("c1", 3), summary("s1", "c1", 4, "running")], true)).toEqual({
      kind: "writing",
      messageId: "s1",
    });
    expect(summaryStateOf([answer("a1", "u1", 2), marker("c1", 3)], true)).toEqual({
      kind: "writing",
      messageId: null,
    });
    expect(summaryStateOf([answer("a1", "u1", 2), marker("c1", 3)], false)).toEqual({
      kind: "stranded",
      markerId: "c1",
    });
  });

  it("is settled when the newest marker is older than a finished answer, and on anything that is not a list", () => {
    expect(
      summaryStateOf([marker("c1", 1), summary("s1", "c1", 2, "aborted"), user("u2", 3), answer("a2", "u2", 4)], false),
    ).toEqual({ kind: "settled" });
    expect(summaryStateOf(null, false)).toEqual({ kind: "settled" });
  });
});

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

describe("a person's message after a summary left unfinished", () => {
  let dir: string;
  let log: string;
  let m: SessionManager | undefined;
  // What the slot answers, one reading after the other; the last one repeats.
  let readings: SummaryState[];
  let reads: number;
  const summaryState = async () => {
    const state = readings[Math.min(reads, readings.length - 1)] ?? { kind: "settled" };
    reads += 1;
    return state;
  };
  const sent = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as string);

  beforeEach(() => {
    useBridgeClock();
    dir = mkdtempSync(join(tmpdir(), "aborted-summary-"));
    log = join(dir, "prompts.log");
    readings = [];
    reads = 0;
  });

  afterEach(async () => {
    await m?.shutdown();
    m = undefined;
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("has the session summarise under a marker of its own first, then sends the message, which is answered", async () => {
    readings = [{ kind: "stranded", markerId: "c1" }, { kind: "settled" }];
    m = new SessionManager(config([`FAKE_PROMPT_LOG=${log}`, "FAKE_ECHO_PROMPT=1"]), undefined, { summaryState });
    const summaries: string[] = [];
    const texts: string[] = [];
    await m.prompt(
      "doc-qa",
      "111",
      "ok",
      (u) => {
        if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") texts.push(u.content.text);
      },
      { opensTurn: true, onSummary: (s) => summaries.push(s) },
    );
    expect(sent()).toEqual([SUMMARY_COMMAND, "ok"]);
    // The message's own turn answers it, and the summary is not that answer.
    expect(texts.join("")).toBe("ok");
    expect(summaries).toEqual([SUMMARY_COMMAND]);
  });

  it("sends the message as it is when nothing was left unfinished", async () => {
    readings = [{ kind: "settled" }];
    m = new SessionManager(config([`FAKE_PROMPT_LOG=${log}`]), undefined, { summaryState });
    await m.prompt("doc-qa", "111", "ok", undefined, { opensTurn: true });
    expect(sent()).toEqual(["ok"]);
  });

  it("waits for a summary being written and says so, then sends the message without summarising again", async () => {
    readings = [{ kind: "writing", messageId: "s1" }, { kind: "writing", messageId: "s1" }, { kind: "settled" }];
    m = new SessionManager(config([`FAKE_PROMPT_LOG=${log}`]), undefined, { summaryState });
    const mm = m;
    const compacting: boolean[] = [];
    const turn = mm.prompt("doc-qa", "111", "ok", undefined, {
      opensTurn: true,
      onCompaction: (on) => compacting.push(on),
    });
    await untilChild(() => expect(compacting).toEqual([true]));
    await vi.advanceTimersByTimeAsync(2 * COMPACTION_PROBE_EVERY_MS);
    await turn;
    expect(compacting).toEqual([true, false]);
    expect(sent()).toEqual(["ok"]);
  });

  it("does not send the message when the summary is still unfinished after it was asked again", async () => {
    readings = [{ kind: "stranded", markerId: "c1" }];
    m = new SessionManager(config([`FAKE_PROMPT_LOG=${log}`]), undefined, { summaryState });
    await expect(m.prompt("doc-qa", "111", "ok", undefined, { opensTurn: true })).rejects.toBeInstanceOf(
      SummaryNotSettledError,
    );
    expect(sent()).toEqual([SUMMARY_COMMAND]);
  });

  it("does not read the session for a prompt that continues a turn already running", async () => {
    readings = [{ kind: "stranded", markerId: "c1" }];
    m = new SessionManager(config([`FAKE_PROMPT_LOG=${log}`]), undefined, { summaryState });
    await m.prompt("doc-qa", "111", "ancora", undefined, {});
    expect(reads).toBe(0);
    expect(sent()).toEqual(["ancora"]);
  });
});

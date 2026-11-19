// A message a person writes while their assistant is writing the answer to the
// previous one. The message joins the work in progress, and after the answer
// opencode writes the summary of the session under it and stops, so the
// message gets no answer of its own. The bridge withholds the summary from the
// chat and must send the person's message again, once, as a prompt of its own.
// A message written while the bridge has the session write its own summary
// before a message must wait for its turn, because an answer given inside that
// summary is kept as summary text and never reaches the chat. A message
// written during the summary opencode writes on its own in the middle of a
// turn joins the work after it.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConfig, BridgeConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import { execOpenCallProbe, type SlotExec } from "./opencode-rest.js";
import { SessionManager, type SessionManagerOptions } from "./session-manager.js";
import { specTest } from "./test-support/spec-rows.js";
import { TurnMetaTracker } from "./turn-meta.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

// Three tool steps before the answer leave room to write during the work, and
// 150 ms is long enough for the second message to arrive without a fixed sleep.
const LOOP_STEPS = 3;
const STEP_MS = 150;
const WAIT_MS = 6_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What the fake agent logged at the start of one loop step. */
interface ModelLogEntry {
  loop: number;
  step: number;
  answer: boolean;
  summary?: boolean;
  taken: string[];
}

/** One part of a message in the session log. */
interface SessionPart {
  type?: string;
  text?: string;
  synthetic?: boolean;
}

/** One message in the session log, as opencode stores it. */
interface SessionMessage {
  info?: { id?: string; role?: string; parentID?: string; summary?: boolean };
  parts?: SessionPart[];
}

/** The session log's messages, or null when it is missing or does not parse. */
function parseSessionLog(path: string): SessionMessage[] | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SessionMessage[]) : null;
  } catch {
    return null;
  }
}

/** The person's words in a prompt, after the bridge's [turn_meta:] block. */
function personPart(taken: string): string {
  if (taken.startsWith("[turn_meta:")) {
    const blank = taken.indexOf("\n\n");
    if (blank >= 0) return taken.slice(blank + 2);
  }
  return taken;
}

interface Harness {
  dispatcher: Dispatcher;
  manager: SessionManager;
  sent: string[];
  summaries: string[];
  readLog: () => ModelLogEntry[];
  readSession: () => SessionMessage[];
  waitFor: (predicate: (entries: ModelLogEntry[]) => boolean, what: string) => Promise<ModelLogEntry[]>;
  shutdown: () => Promise<void>;
}

function makeHarness(
  options: Pick<SessionManagerOptions, "sessionMessages" | "summaryState" | "turnSilenceMs"> & {
    summaryAfterAnswer?: boolean;
    autoSummary?: { afterSteps: number; silentMs: number };
    readsOpenCall?: boolean;
  } = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), "cerase-written-during-summary-"));
  const modelLog = join(dir, "model.log");
  const sessionLog = join(dir, "session.json");
  const config: BridgeConfig = {
    agents: [
      {
        id: "doc-qa",
        channel: "discord",
        cwd: "/home/agent/cerase/workspace",
        mode: "cerase",
        bot_token: "irrelevant",
        allowed_users: ["111"],
        spawn: {
          command: "env",
          args: [
            "--",
            `FAKE_LOOP_STEPS=${LOOP_STEPS}`,
            `FAKE_STEP_MS=${STEP_MS}`,
            `FAKE_MODEL_LOG=${modelLog}`,
            `FAKE_SESSION_LOG=${sessionLog}`,
            ...(options.autoSummary
              ? [
                  `FAKE_AUTO_SUMMARY_AFTER_STEPS=${options.autoSummary.afterSteps}`,
                  `FAKE_AUTO_SUMMARY_SILENT_MS=${options.autoSummary.silentMs}`,
                ]
              : []),
            ...(options.summaryAfterAnswer === false || options.autoSummary ? [] : ["FAKE_SUMMARY_AFTER_ANSWER=1"]),
            "FAKE_SUMMARY_ID=msg_summary",
            "node",
            FAKE_CHILD,
          ],
        },
      },
    ],
    session: { idle_timeout_minutes: 60, max_concurrent: 16 },
  };
  // The session is read from the fake child's log unless a test fixes what it shows.
  const sessionLogExec: SlotExec = async (args) => {
    const limit = Number(/limit=(\d+)/.exec(args.at(-1) ?? "")?.[1] ?? Number.MAX_SAFE_INTEGER);
    const messages = parseSessionLog(sessionLog) ?? [];
    return { stdout: `${JSON.stringify(messages.slice(-limit))}\n200`, ok: true };
  };
  const sessionOptions: SessionManagerOptions = {
    endpointResolver: () => null,
    messageKindProbe: async (_agent: AgentConfig, _sessionId: string, messageId: string) =>
      messageId === "msg_summary" ? "summary" : "answer",
    sessionMessages:
      options.sessionMessages ??
      (async (_agent: AgentConfig, _sessionId: string, limit: number) => {
        const messages = parseSessionLog(sessionLog);
        return messages === null ? null : messages.slice(-limit);
      }),
    summaryState: options.summaryState,
    turnSilenceMs: options.turnSilenceMs,
    ...(options.readsOpenCall
      ? {
          openCallProbe: (_agent: AgentConfig, sessionId: string) =>
            execOpenCallProbe(sessionLogExec)("cerase-agent-doc-qa", sessionId),
        }
      : {}),
  };
  const manager = new SessionManager(config, undefined, sessionOptions);
  const sent: string[] = [];
  const summaries: string[] = [];
  const dispatcher = new Dispatcher({
    config,
    sessionManager: manager,
    turnMeta: new TurnMetaTracker(),
    resolveSendTarget: () => async (text) => {
      sent.push(text);
      return { ok: true };
    },
    onSummaryWithheld: (_agentId, summary) => summaries.push(summary),
  });

  const readLog = (): ModelLogEntry[] => {
    let raw: string;
    try {
      raw = readFileSync(modelLog, "utf8");
    } catch {
      return [];
    }
    const entries: ModelLogEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as ModelLogEntry);
      } catch {
        // A line still being appended: the next poll reads it whole.
      }
    }
    return entries;
  };

  const waitFor = async (predicate: (entries: ModelLogEntry[]) => boolean, what: string): Promise<ModelLogEntry[]> => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const entries = readLog();
      if (predicate(entries)) return entries;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}; the model log held:\n${JSON.stringify(entries, null, 2)}`);
      }
      await sleep(10);
    }
  };

  return {
    dispatcher,
    manager,
    sent,
    summaries,
    readLog,
    readSession: () => parseSessionLog(sessionLog) ?? [],
    waitFor,
    shutdown: async () => {
      await manager.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The separate answers the channel received, in order. */
function answers(sent: string[]): string[] {
  return sent.map((text) => text.replace(/ ⏎$/u, "")).filter((text) => text.includes("answer to:"));
}

/** The user messages whose non-synthetic text is the person's words. */
function personMessages(messages: SessionMessage[], words: string): SessionMessage[] {
  return messages.filter(
    (message) =>
      message.info?.role === "user" &&
      (message.parts ?? []).some(
        (part) => part.type === "text" && part.synthetic !== true && personPart(part.text ?? "") === words,
      ),
  );
}

describe("a message written while the previous work runs and opencode ends on a summary", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.shutdown();
    harness = undefined;
  });

  specTest(
    "ACP-TURN-042",
    "is sent again after the turn's answer when the summary ends it, and is answered",
    async (row) => {
      harness = makeHarness();
      const { dispatcher } = harness;

      const first = dispatcher.handleMessage("doc-qa", "111", "first");
      await harness.waitFor(
        (entries) => entries.some((entry) => entry.loop === 1 && entry.answer),
        "the first work's answer step",
      );
      const second = dispatcher.handleMessage("doc-qa", "111", "second");

      const results = await Promise.all([first, second]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);

      expect(answers(harness.sent)).toEqual(["answer to: first", "answer to: second"]);
      expect(harness.sent.some((text) => text.includes("## Goal"))).toBe(false);

      const entries = harness.readLog();
      const secondSteps = entries.filter((entry) => entry.taken.some((t) => personPart(t) === "second"));
      expect(secondSteps).toHaveLength(1);
      expect(secondSteps[0]!.loop).toBe(2);

      const sentAgainMessages = personMessages(harness.readSession(), "second");
      expect(sentAgainMessages).toHaveLength(2);

      const order = answers(harness.sent);
      const received = order.includes("answer to: second");
      const sentAgain = sentAgainMessages.length - 1;
      const afterAnswer = received && order.indexOf("answer to: second") > order.indexOf("answer to: first");
      const observed = `the message is ${sentAgain === 1 ? "sent again once" : `sent again ${sentAgain} times`}, ${afterAnswer ? "after the turn's answer" : "not after the turn's answer"}, and the person ${received ? "receives its answer" : "receives no answer to it"}`;
      expect(observed).toBe(row.expect);
    },
  );

  it("sends the message again once even when the session never shows it answered", async () => {
    const fixed: SessionMessage[] = [
      { info: { id: "msg_user_first", role: "user" }, parts: [{ type: "text", text: "first" }] },
      { info: { id: "msg_answer", role: "assistant" }, parts: [{ type: "text", text: "answer to: first" }] },
      { info: { id: "msg_user_second", role: "user" }, parts: [{ type: "text", text: "second" }] },
      { info: { id: "msg_summary", role: "assistant", summary: true }, parts: [] },
    ];
    harness = makeHarness({ sessionMessages: async () => fixed });
    const { dispatcher } = harness;

    const first = dispatcher.handleMessage("doc-qa", "111", "first");
    await harness.waitFor(
      (entries) => entries.some((entry) => entry.loop === 1 && entry.answer),
      "the first work's answer step",
    );
    const second = dispatcher.handleMessage("doc-qa", "111", "second");

    const results = await Promise.all([first, second]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);

    expect(answers(harness.sent)).toEqual(["answer to: first", "answer to: second"]);

    const secondSteps = harness.readLog().filter((entry) => entry.taken.some((text) => personPart(text) === "second"));
    expect(secondSteps).toHaveLength(1);
    expect(secondSteps[0]!.loop).toBe(2);
  });

  it("sends nothing again when the message is followed by an answer before the summary", async () => {
    const fixed: SessionMessage[] = [
      { info: { id: "msg_user_first", role: "user" }, parts: [{ type: "text", text: "first" }] },
      { info: { id: "msg_user_second", role: "user" }, parts: [{ type: "text", text: "second" }] },
      { info: { id: "msg_answer_second", role: "assistant" }, parts: [{ type: "text", text: "answer to: second" }] },
      { info: { id: "msg_summary", role: "assistant", summary: true }, parts: [] },
    ];
    harness = makeHarness({ sessionMessages: async () => fixed });
    const { dispatcher } = harness;

    const first = dispatcher.handleMessage("doc-qa", "111", "first");
    await harness.waitFor(
      (entries) => entries.some((entry) => entry.loop === 1 && entry.answer),
      "the first work's answer step",
    );
    const second = dispatcher.handleMessage("doc-qa", "111", "second");

    const results = await Promise.all([first, second]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);

    expect(answers(harness.sent)).toEqual(["answer to: first"]);
    expect(harness.readLog().some((entry) => entry.loop === 2)).toBe(false);
  });
});

describe("a message written while the bridge has the session summarise before the turn's message", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.shutdown();
    harness = undefined;
  });

  specTest(
    "ACP-TURN-043",
    "waits for its turn and gets its own answer, and the rolling summary holds none of it",
    async (row) => {
      let reads = 0;
      harness = makeHarness({
        summaryState: async () => {
          reads += 1;
          return reads === 1 ? { kind: "stranded", markerId: "c1" } : { kind: "settled" };
        },
        summaryAfterAnswer: false,
      });
      const { dispatcher } = harness;

      const first = dispatcher.handleMessage("doc-qa", "111", "first");
      await harness.waitFor(
        (entries) => entries.some((entry) => entry.taken.includes("/compact")),
        "the summary's first step",
      );
      const second = dispatcher.handleMessage("doc-qa", "111", "second");

      expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);

      expect(answers(harness.sent)).toEqual(["answer to: first", "answer to: second"]);
      expect(harness.summaries.some((summary) => summary.includes("second"))).toBe(false);
      expect(harness.summaries).toHaveLength(1);

      const entries = harness.readLog();
      const summaryLoop = entries.find((entry) => entry.taken.includes("/compact"))!.loop;
      const secondSteps = entries.filter((entry) => entry.taken.some((taken) => personPart(taken) === "second"));
      expect(secondSteps).toHaveLength(1);
      expect(secondSteps.every((entry) => entry.loop !== summaryLoop)).toBe(true);

      const joined = secondSteps.some((entry) => entry.loop === summaryLoop);
      const received = answers(harness.sent).includes("answer to: second");
      const kept = harness.summaries.some((summary) => summary.includes("second"));
      const observed = `the message ${joined ? "joins the summary" : "waits for its turn"}, the person ${received ? "receives its own answer" : "receives no answer to it"}, and the rolling summary ${kept ? "holds its answer" : "holds none of it"}`;
      expect(observed).toBe(row.expect);
    },
  );
});

describe("a message written while opencode writes its automatic summary in the middle of a turn", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.shutdown();
    harness = undefined;
  });

  specTest(
    "ACP-TURN-053",
    "is taken into the work after the summary, answered once, never sent again, and the request finishes",
    async (row) => {
      harness = makeHarness({
        autoSummary: { afterSteps: 1, silentMs: 2_500 },
        turnSilenceMs: 500,
        readsOpenCall: true,
        summaryAfterAnswer: false,
      });
      const { dispatcher } = harness;

      const first = dispatcher.handleMessage("doc-qa", "111", "first");
      await harness.waitFor(
        (entries) => entries.some((entry) => entry.summary === true),
        "the automatic summary's step",
      );
      const second = dispatcher.handleMessage("doc-qa", "111", "second");

      expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);

      const sentAnswers = answers(harness.sent);
      expect(sentAnswers).toEqual(["answer to: first + second"]);
      expect(harness.sent.some((text) => text.includes("## Goal"))).toBe(false);

      expect(harness.summaries).toHaveLength(1);
      expect(harness.summaries.some((summary) => summary.includes("second"))).toBe(false);

      const entries = harness.readLog();
      const summaryStep = entries.find((entry) => entry.summary === true)!;
      const secondSteps = entries.filter((entry) => entry.taken.some((taken) => personPart(taken) === "second"));
      expect(secondSteps).toHaveLength(1);
      expect(secondSteps[0]!.loop).toBe(summaryStep.loop);
      expect(secondSteps[0]!.step).toBeGreaterThan(summaryStep.step);
      expect(
        entries.some((entry) => entry.loop === summaryStep.loop && entry.answer && entry.step > secondSteps[0]!.step),
      ).toBe(true);
      expect(entries.some((entry) => entry.loop === 2)).toBe(false);

      expect(personMessages(harness.readSession(), "second")).toHaveLength(1);
      expect(personMessages(harness.readSession(), "first")).toHaveLength(1);

      const taken =
        secondSteps.length === 1 &&
        secondSteps[0]!.loop === summaryStep.loop &&
        secondSteps[0]!.step > summaryStep.step;
      const n = sentAnswers.filter((answer) => answer.includes("second")).length;
      const once = n === 1;
      const sentAgain = personMessages(harness.readSession(), "second").length > 1;
      const finishes = sentAnswers.some((answer) => answer.includes("first"));
      const observed = `the message is ${taken ? "taken into the work after the summary" : "not taken into the work after the summary"} and ${once ? "answered once with it" : `answered ${n} times`}, ${sentAgain ? "it is sent again" : "it is not sent again"}, and the person's request ${finishes ? "finishes" : "does not finish"}`;
      expect(observed).toBe(row.expect);
    },
  );
});

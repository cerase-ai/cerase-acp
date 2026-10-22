// A message a person writes while their assistant is still working on the
// previous one. opencode takes such a prompt into the work in progress, as the
// model's next step, and answers both prompts when the work ends. The bridge
// must mark the later text as written during that work, and must leave
// scheduled messages and platform notes out of it.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { BridgeConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import { SessionManager } from "./session-manager.js";
import { TurnMetaTracker } from "./turn-meta.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

// Three tool steps before the answer leaves room to write during the work, and
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
  taken: string[];
}

/** The person's words in a prompt, after the bridge's [turn_meta:] block. */
function personPart(taken: string): string {
  if (taken.startsWith("[turn_meta:")) {
    const blank = taken.indexOf("\n\n");
    if (blank >= 0) return taken.slice(blank + 2);
  }
  return taken;
}

/** Whether a prompt carries the field saying it was written while a turn ran. */
function writtenDuringPreviousWork(taken: string): boolean {
  if (!taken.startsWith("[turn_meta:")) return false;
  const blank = taken.indexOf("\n\n");
  const block = blank >= 0 ? taken.slice(0, blank) : taken;
  return block.includes("written_during_previous_work=");
}

interface Harness {
  dispatcher: Dispatcher;
  manager: SessionManager;
  sent: string[];
  readLog: () => ModelLogEntry[];
  waitFor: (predicate: (entries: ModelLogEntry[]) => boolean, what: string) => Promise<ModelLogEntry[]>;
  shutdown: () => Promise<void>;
}

interface HarnessOptions {
  /** How long each delivery to the channel takes. */
  sendDelayMs?: number;
  onFirstDeliveryStart?: () => void;
  onFirstDeliveryEnd?: () => void;
}

function makeHarness(opts: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "cerase-written-during-"));
  const modelLog = join(dir, "model.log");
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
            "node",
            FAKE_CHILD,
          ],
        },
      },
    ],
    session: { idle_timeout_minutes: 60, max_concurrent: 16 },
  };
  const manager = new SessionManager(config);
  const sent: string[] = [];
  let deliveries = 0;
  const dispatcher = new Dispatcher({
    config,
    sessionManager: manager,
    turnMeta: new TurnMetaTracker(),
    resolveSendTarget: () => async (text) => {
      const first = deliveries === 0;
      deliveries += 1;
      sent.push(text);
      if (first) opts.onFirstDeliveryStart?.();
      if (opts.sendDelayMs) await sleep(opts.sendDelayMs);
      if (first) opts.onFirstDeliveryEnd?.();
      return { ok: true };
    },
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
    readLog,
    waitFor,
    shutdown: async () => {
      await manager.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Every text the model was given, across every step of every work. */
function allTaken(entries: ModelLogEntry[]): string[] {
  return entries.flatMap((entry) => entry.taken);
}

/** Only the texts taken by one work. */
function takenBy(entries: ModelLogEntry[], loop: number): string[] {
  return allTaken(entries.filter((entry) => entry.loop === loop));
}

/** The channel's answer, joined back from the chunks it received. */
function answerText(sent: string[]): string {
  return sent.map((text) => text.replace(/ ⏎$/u, "")).join("");
}

/** The separate answers the channel received, in order. */
function answers(sent: string[]): string[] {
  return sent.map((text) => text.replace(/ ⏎$/u, "")).filter((text) => text.includes("answer to:"));
}

describe("a message written while the previous work runs", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.shutdown();
    harness = undefined;
  });

  it("joins a work at a tool step, marked, and the work answers both once", async () => {
    harness = makeHarness();
    const { dispatcher } = harness;

    const first = dispatcher.handleMessage("doc-qa", "111", "first");
    await harness.waitFor(
      (entries) =>
        entries.some(
          (entry) => entry.loop === 1 && !entry.answer && entry.taken.some((t) => personPart(t) === "first"),
        ),
      "the first work's first tool step",
    );
    const second = dispatcher.handleMessage("doc-qa", "111", "second");

    const results = await Promise.all([first, second]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);

    const entries = harness.readLog();
    const secondSteps = entries.filter((entry) => entry.taken.some((t) => personPart(t) === "second"));
    expect(secondSteps).toHaveLength(1);
    expect(secondSteps[0]!.loop).toBe(1);
    expect(secondSteps[0]!.answer).toBe(false);

    const answerAt = entries.findIndex((entry) => entry.loop === 1 && entry.answer);
    const secondAt = entries.findIndex((entry) => entry.taken.some((t) => personPart(t) === "second"));
    expect(answerAt).toBeGreaterThanOrEqual(0);
    expect(secondAt).toBeLessThan(answerAt);

    const firstText = allTaken(entries).find((t) => personPart(t) === "first")!;
    const secondText = allTaken(entries).find((t) => personPart(t) === "second")!;
    expect(writtenDuringPreviousWork(firstText)).toBe(false);
    expect(writtenDuringPreviousWork(secondText)).toBe(true);

    const answer = answerText(harness.sent);
    expect(answer.match(/answer to:/g)).toHaveLength(1);
    expect(answer).toBe("answer to: first + second");
  });

  it("waits for the answer step to end, then runs as its own work, marked", async () => {
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

    const entries = harness.readLog();
    expect(takenBy(entries, 1).filter((t) => personPart(t) === "second")).toHaveLength(0);
    const secondSteps = entries.filter((entry) => entry.taken.some((t) => personPart(t) === "second"));
    expect(secondSteps).toHaveLength(1);
    expect(secondSteps[0]!.loop).toBe(2);

    const firstText = allTaken(entries).find((t) => personPart(t) === "first")!;
    const secondText = allTaken(entries).find((t) => personPart(t) === "second")!;
    expect(writtenDuringPreviousWork(firstText)).toBe(false);
    expect(writtenDuringPreviousWork(secondText)).toBe(true);

    expect(answers(harness.sent)).toEqual(["answer to: first", "answer to: second"]);
  });

  it("is marked when it arrives while the first turn is delivering, and runs after it", async () => {
    let deliveryStarted: () => void = () => {};
    let deliveryEnded: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      deliveryStarted = resolve;
    });
    const ended = new Promise<void>((resolve) => {
      deliveryEnded = resolve;
    });
    harness = makeHarness({
      sendDelayMs: 400,
      onFirstDeliveryStart: () => deliveryStarted(),
      onFirstDeliveryEnd: () => deliveryEnded(),
    });
    const { dispatcher } = harness;

    const first = dispatcher.handleMessage("doc-qa", "111", "first");
    await harness.waitFor(
      (entries) => entries.some((entry) => entry.loop === 1 && entry.answer),
      "the first work's answer step",
    );
    await started;
    const firstDeliveryEndedAt = ended.then(() => Date.now());

    const second = dispatcher.handleMessage("doc-qa", "111", "second");
    const secondWorkSeenAt = harness
      .waitFor((entries) => entries.some((entry) => entry.loop === 2), "the second work")
      .then(() => Date.now());

    const results = await Promise.all([first, second]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);

    expect(await secondWorkSeenAt).toBeGreaterThanOrEqual(await firstDeliveryEndedAt);

    const entries = harness.readLog();
    expect(takenBy(entries, 1).filter((t) => personPart(t) === "second")).toHaveLength(0);
    const secondSteps = entries.filter((entry) => entry.taken.some((t) => personPart(t) === "second"));
    expect(secondSteps).toHaveLength(1);
    expect(secondSteps[0]!.loop).toBe(2);

    const firstText = allTaken(entries).find((t) => personPart(t) === "first")!;
    const secondText = allTaken(entries).find((t) => personPart(t) === "second")!;
    expect(writtenDuringPreviousWork(firstText)).toBe(false);
    expect(writtenDuringPreviousWork(secondText)).toBe(true);

    expect(answers(harness.sent)).toEqual(["answer to: first", "answer to: second"]);
  });

  it("does not take a scheduled message into the work, nor mark it", async () => {
    harness = makeHarness();
    const { dispatcher } = harness;

    const first = dispatcher.handleMessage("doc-qa", "111", "first");
    await harness.waitFor(
      (entries) =>
        entries.some(
          (entry) => entry.loop === 1 && !entry.answer && entry.taken.some((t) => personPart(t) === "first"),
        ),
      "the first work's first tool step",
    );
    const scheduled = dispatcher.handleMessage("doc-qa", "111", "scheduled", Date.now(), { byPerson: false });

    const results = await Promise.all([first, scheduled]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);

    const entries = harness.readLog();
    expect(takenBy(entries, 1).filter((t) => personPart(t) === "scheduled")).toHaveLength(0);
    const scheduledSteps = entries.filter((entry) => entry.taken.some((t) => personPart(t) === "scheduled"));
    expect(scheduledSteps).toHaveLength(1);
    expect(scheduledSteps[0]!.loop).toBe(2);

    const scheduledText = scheduledSteps[0]!.taken.find((t) => personPart(t) === "scheduled")!;
    expect(writtenDuringPreviousWork(scheduledText)).toBe(false);
  });

  it("does not take a platform note into the work, nor mark it", async () => {
    harness = makeHarness();
    const { dispatcher } = harness;
    const note = "[platform_note sig=abc123] An approval arrived";

    const first = dispatcher.handleMessage("doc-qa", "111", "first");
    await harness.waitFor(
      (entries) =>
        entries.some(
          (entry) => entry.loop === 1 && !entry.answer && entry.taken.some((t) => personPart(t) === "first"),
        ),
      "the first work's first tool step",
    );
    const noted = dispatcher.handleMessage("doc-qa", "111", note);

    const results = await Promise.all([first, noted]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);

    const entries = harness.readLog();
    expect(takenBy(entries, 1).filter((t) => t.includes("platform_note sig="))).toHaveLength(0);
    const noteSteps = entries.filter((entry) => entry.taken.some((t) => t.includes("platform_note sig=")));
    expect(noteSteps).toHaveLength(1);
    expect(noteSteps[0]!.loop).toBe(2);

    const noteText = noteSteps[0]!.taken.find((t) => t.includes("platform_note sig="))!;
    expect(personPart(noteText)).toContain("An approval arrived");
    expect(writtenDuringPreviousWork(noteText)).toBe(false);
  });
});

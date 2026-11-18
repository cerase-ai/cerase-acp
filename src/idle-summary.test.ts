// The control-plane asks the bridge to summarise a person's idle session
// through POST /internal/summarise. The bridge refuses while a turn of that
// conversation runs, while one of its messages waits for its turn, or while a
// message is still being checked; otherwise it accepts, holds the
// conversation's order until the summary settles, and writes the summary
// itself by sending opencode's /compact to the session, keeping the summary's
// text out of the chat.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isAllowed } from "./allowlist.js";
import type { BridgeConfig } from "./config.js";
import { Dispatcher, type DispatcherDeps } from "./dispatcher.js";
import { type InternalServer, startInternalServer } from "./internal-server.js";
import { PendingMessages } from "./pending-messages.js";
import { SessionManager, SUMMARY_COMMAND } from "./session-manager.js";
import { specTest } from "./test-support/spec-rows.js";
import { TurnMetaTracker } from "./turn-meta.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));
const SECRET = "test-internal-secret";

// Three tool steps before the answer leave room to ask for a summary while the
// work runs, and 150 ms is long enough for a second message to arrive without
// a fixed sleep.
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

/** What the endpoint answers: the two bodies these tests read. */
interface SummaryBody {
  error?: string;
  status?: string;
}

interface SummaryResponse {
  status: number;
  body: SummaryBody;
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

interface Harness {
  dispatcher: Dispatcher;
  manager: SessionManager;
  base: string;
  sent: string[];
  summaryCalls: Array<[string, string]>;
  summaries: Array<[string, string]>;
  events: string[];
  readLog: () => ModelLogEntry[];
  readSession: () => SessionMessage[];
  prompts: () => string[];
  rawPrompts: () => string[];
  kept: () => string[];
  waitFor: (predicate: (entries: ModelLogEntry[]) => boolean, what: string) => Promise<ModelLogEntry[]>;
  waitUntil: (predicate: () => boolean, what: string) => Promise<void>;
  summarise: (body: unknown, auth?: string | null) => Promise<SummaryResponse>;
  armCreditGate: () => void;
  creditCheckCalled: () => boolean;
  openCreditGate: () => void;
  releaseSummary: () => void;
  shutdown: () => Promise<void>;
}

interface HarnessOptions {
  allowedUsers?: string[];
  realSummary?: boolean;
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "cerase-idle-summary-"));
  const modelLog = join(dir, "model.log");
  const promptLog = join(dir, "prompts.log");
  const sessionLog = join(dir, "session.json");
  const pendingDir = join(dir, "pending");
  mkdirSync(pendingDir, { recursive: true });
  const config: BridgeConfig = {
    agents: [
      {
        id: "doc-qa",
        channel: "discord",
        cwd: "/home/agent/cerase/workspace",
        mode: "cerase",
        bot_token: "irrelevant",
        allowed_users: options.allowedUsers ?? ["111"],
        spawn: {
          command: "env",
          args: [
            "--",
            `FAKE_LOOP_STEPS=${LOOP_STEPS}`,
            `FAKE_STEP_MS=${STEP_MS}`,
            `FAKE_MODEL_LOG=${modelLog}`,
            `FAKE_PROMPT_LOG=${promptLog}`,
            `FAKE_SESSION_LOG=${sessionLog}`,
            "node",
            FAKE_CHILD,
          ],
        },
      },
    ],
    session: { idle_timeout_minutes: 60, max_concurrent: 16 },
  };
  const manager = new SessionManager(config, undefined, { endpointResolver: () => null });

  const sent: string[] = [];
  const summaryCalls: Array<[string, string]> = [];
  const summaries: Array<[string, string]> = [];
  const events: string[] = [];
  const summaryResolvers: Array<() => void> = [];
  const pending = new PendingMessages(pendingDir);

  let creditArmed = false;
  let creditCalled = false;
  let releaseCredit: (() => void) | undefined;

  const armCreditGate = (): void => {
    creditArmed = true;
    creditCalled = false;
  };
  const openCreditGate = (): void => {
    creditArmed = false;
    const release = releaseCredit;
    releaseCredit = undefined;
    release?.();
  };
  const creditCheck = async (): Promise<{ exhausted: boolean }> => {
    if (!creditArmed) return { exhausted: false };
    creditCalled = true;
    await new Promise<void>((resolve) => {
      releaseCredit = resolve;
    });
    return { exhausted: false };
  };

  const writeSummary = (agentId: string, userId: string): Promise<void> => {
    summaryCalls.push([agentId, userId]);
    return new Promise<void>((resolve) => {
      summaryResolvers.push(resolve);
    });
  };
  const releaseSummary = (): void => {
    while (summaryResolvers.length > 0) summaryResolvers.shift()!();
  };

  const deps: DispatcherDeps = {
    config,
    sessionManager: manager,
    turnMeta: new TurnMetaTracker(),
    resolveSendTarget: () => async (text) => {
      sent.push(text);
      return { ok: true };
    },
    creditCheck,
    onSummaryWithheld: (agentId, summary) => {
      summaries.push([agentId, summary]);
      events.push("summary");
    },
    pendingMessages: pending,
    ...(options.realSummary ? {} : { writeSummary }),
  };
  const dispatcher = new Dispatcher(deps);

  const server: InternalServer = await startInternalServer({
    dispatcher,
    internalSecret: SECRET,
    port: 0,
    host: "127.0.0.1",
    isAllowed: (agentId, userId) => {
      try {
        return isAllowed(config, agentId, userId);
      } catch {
        return false;
      }
    },
  });
  const base = `http://127.0.0.1:${server.port()}`;

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

  const prompts = (): string[] => {
    let raw: string;
    try {
      raw = readFileSync(promptLog, "utf8");
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(personPart(JSON.parse(line) as string));
      } catch {
        // A line still being appended: the next read sees it whole.
      }
    }
    return out;
  };

  const rawPrompts = (): string[] => {
    let raw: string;
    try {
      raw = readFileSync(promptLog, "utf8");
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as string);
      } catch {
        // A line still being appended: the next read sees it whole.
      }
    }
    return out;
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

  const waitUntil = async (predicate: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      if (predicate()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(10);
    }
  };

  const summarise = async (body: unknown, auth: string | null = `Bearer ${SECRET}`): Promise<SummaryResponse> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth !== null) headers.authorization = auth;
    const res = await fetch(`${base}/internal/summarise`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const parsed = (await res.json().catch(() => ({}))) as SummaryBody;
    return { status: res.status, body: parsed };
  };

  return {
    dispatcher,
    manager,
    base,
    sent,
    summaryCalls,
    summaries,
    events,
    readLog,
    readSession: () => parseSessionLog(sessionLog) ?? [],
    prompts,
    rawPrompts,
    kept: () => pending.list().map((message) => message.text),
    waitFor,
    waitUntil,
    summarise,
    armCreditGate,
    creditCheckCalled: () => creditCalled,
    openCreditGate,
    releaseSummary,
    shutdown: async () => {
      await server.close();
      manager.stopStartingTurns();
      openCreditGate();
      releaseSummary();
      await manager.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("a summary the control-plane asks of the bridge", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.shutdown();
    harness = undefined;
  });

  specTest("ACP-TURN-045", "refuses while a turn of the conversation runs", async (row) => {
    harness = await makeHarness();
    const { dispatcher, manager } = harness;

    const first = dispatcher.handleMessage("doc-qa", "111", "first");
    void first.catch(() => undefined);
    await harness.waitFor(
      (entries) => entries.some((entry) => entry.taken.some((taken) => personPart(taken) === "first")),
      "the first work to take the first message",
    );
    const sessionId = manager.currentSessionId("doc-qa", "111");

    const { status, body } = await harness.summarise({
      agent_id: "doc-qa",
      user_id: "111",
      session_id: sessionId,
    });

    expect(status).toBe(409);
    expect(body).toEqual({ error: "busy" });

    expect(await first).toEqual({ ok: true });
    expect(harness.prompts()).toEqual(["first"]);
    expect(harness.summaryCalls).toEqual([]);

    const nothingSent = harness.summaryCalls.length === 0 && harness.prompts().length === 1;
    const observed = `the bridge answers ${status} ${body.error} and ${nothingSent ? "sends nothing to the assistant" : "sends the assistant something"}`;
    expect(observed).toBe(row.expect);
  });

  specTest("ACP-TURN-046", "refuses while a message of the conversation waits for its turn", async (row) => {
    harness = await makeHarness();
    const { dispatcher, manager } = harness;

    const first = dispatcher.handleMessage("doc-qa", "111", "first");
    void first.catch(() => undefined);
    await harness.waitFor(
      (entries) => entries.some((entry) => entry.taken.some((taken) => personPart(taken) === "first")),
      "the first work to take the first message",
    );

    const second = dispatcher.handleMessage("doc-qa", "111", "second", Date.now(), { byPerson: false });
    void second.catch(() => undefined);
    await harness.waitUntil(() => manager.turnsInFlight("doc-qa") === 2, "the second message to wait for its turn");
    const sessionId = manager.currentSessionId("doc-qa", "111");

    const { status, body } = await harness.summarise({
      agent_id: "doc-qa",
      user_id: "111",
      session_id: sessionId,
    });

    expect(status).toBe(409);
    expect(body).toEqual({ error: "busy" });

    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
    expect(harness.prompts()).toEqual(["first", "second"]);
    expect(answers(harness.sent)).toEqual(["answer to: first", "answer to: second"]);
    expect(harness.summaryCalls).toEqual([]);

    const nothingSent = harness.summaryCalls.length === 0;
    const order = answers(harness.sent);
    const secondAnsweredNext = order[0] === "answer to: first" && order[1] === "answer to: second";
    const observed = `the bridge answers ${status} ${body.error}, ${nothingSent ? "sends nothing to the assistant" : "sends the assistant something"}, and the waiting message ${secondAnsweredNext ? "is answered next" : "is not answered next"}`;
    expect(observed).toBe(row.expect);
  });

  it("refuses while a message received has not yet reached its turn", async () => {
    harness = await makeHarness();
    const { dispatcher, manager } = harness;

    expect(await dispatcher.handleMessage("doc-qa", "111", "first")).toEqual({ ok: true });
    expect(harness.prompts()).toEqual(["first"]);

    harness.armCreditGate();
    const second = dispatcher.handleMessage("doc-qa", "111", "second");
    void second.catch(() => undefined);
    const active = harness;
    await active.waitUntil(() => active.creditCheckCalled(), "the second message's credit check");

    const sessionId = manager.currentSessionId("doc-qa", "111");
    const { status, body } = await harness.summarise({
      agent_id: "doc-qa",
      user_id: "111",
      session_id: sessionId,
    });

    expect(status).toBe(409);
    expect(body).toEqual({ error: "busy" });

    harness.openCreditGate();
    expect(await second).toEqual({ ok: true });
    expect(harness.prompts()).toEqual(["first", "second"]);
    expect(harness.summaryCalls).toEqual([]);
  });

  specTest(
    "ACP-TURN-047",
    "accepts an idle conversation and holds its order until the summary settles",
    async (row) => {
      harness = await makeHarness();
      const { dispatcher, manager } = harness;

      expect(await dispatcher.handleMessage("doc-qa", "111", "first")).toEqual({ ok: true });
      const sessionId = manager.currentSessionId("doc-qa", "111");

      const firstSummary = await harness.summarise({
        agent_id: "doc-qa",
        user_id: "111",
        session_id: sessionId,
      });
      expect(firstSummary.status).toBe(202);
      expect(firstSummary.body).toEqual({ status: "accepted" });

      const active = harness;
      await active.waitUntil(() => active.summaryCalls.length === 1, "writeSummary to be called once");
      expect(harness.summaryCalls[0]).toEqual(["doc-qa", "111"]);

      const second = dispatcher.handleMessage("doc-qa", "111", "second");
      void second.catch(() => undefined);

      const secondSummary = await harness.summarise({
        agent_id: "doc-qa",
        user_id: "111",
        session_id: sessionId,
      });
      expect(secondSummary.status).toBe(409);
      expect(secondSummary.body).toEqual({ error: "busy" });

      await sleep(400);
      expect(harness.prompts()).toEqual(["first"]);
      const waited = harness.prompts().length === 1;

      harness.releaseSummary();
      expect(await second).toEqual({ ok: true });
      expect(harness.prompts()).toEqual(["first", "second"]);
      expect(harness.summaryCalls).toHaveLength(1);

      const observed = `the bridge answers ${firstSummary.status} ${firstSummary.body.status}, and a message sent before the summary ends ${waited ? "waits for it" : "reaches the assistant during it"}`;
      expect(observed).toBe(row.expect);
    },
  );

  specTest(
    "ACP-TURN-048",
    "refuses without its secret, with a wrong one, or for a session it does not hold",
    async (row) => {
      harness = await makeHarness();
      const { dispatcher, manager } = harness;

      expect(await dispatcher.handleMessage("doc-qa", "111", "first")).toEqual({ ok: true });
      const sessionId = manager.currentSessionId("doc-qa", "111");
      const body = { agent_id: "doc-qa", user_id: "111", session_id: sessionId };

      const noAuth = await harness.summarise(body, null);
      const wrong = await harness.summarise(body, "Bearer wrong");
      const unknown = await harness.summarise({
        agent_id: "doc-qa",
        user_id: "111",
        session_id: "ses_not_this_one",
      });

      expect([noAuth.status, wrong.status, unknown.status]).toEqual([401, 401, 404]);
      expect(noAuth.body).toEqual({ error: "unauthorized" });
      expect(wrong.body).toEqual({ error: "unauthorized" });
      expect(unknown.body).toEqual({ error: "unknown_session" });

      expect(harness.summaryCalls).toEqual([]);
      const beforeSecond = harness.prompts();
      expect(beforeSecond).toEqual(["first"]);

      expect(await dispatcher.handleMessage("doc-qa", "111", "second")).toEqual({ ok: true });
      expect(harness.prompts()).toEqual(["first", "second"]);

      const nothingSent = harness.summaryCalls.length === 0 && beforeSecond.length === 1;
      const observed = `the bridge answers ${noAuth.status}, ${wrong.status} and ${unknown.status} and ${nothingSent ? "sends nothing to the assistant" : "sends the assistant something"}`;
      expect(observed).toBe(row.expect);
    },
  );

  it("refuses a user outside the allowlist, a missing or empty session, and another user's session", async () => {
    harness = await makeHarness({ allowedUsers: ["111", "222"] });
    const { dispatcher, manager } = harness;

    expect(await dispatcher.handleMessage("doc-qa", "111", "first")).toEqual({ ok: true });
    const sessionId = manager.currentSessionId("doc-qa", "111");

    const notAllowed = await harness.summarise({
      agent_id: "doc-qa",
      user_id: "999",
      session_id: sessionId,
    });
    expect(notAllowed.status).toBe(403);

    const missing = await harness.summarise({ agent_id: "doc-qa", user_id: "111" });
    expect(missing.status).toBe(400);

    const empty = await harness.summarise({ agent_id: "doc-qa", user_id: "111", session_id: "" });
    expect(empty.status).toBe(400);

    const otherUser = await harness.summarise({
      agent_id: "doc-qa",
      user_id: "222",
      session_id: sessionId,
    });
    expect(otherUser.status).toBe(404);
    expect(otherUser.body).toEqual({ error: "unknown_session" });

    const wrongMethod = await fetch(`${harness.base}/internal/summarise`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(wrongMethod.status).toBe(404);

    expect(harness.summaryCalls).toEqual([]);
    expect(harness.prompts()).toEqual(["first"]);
  });
});

describe("a summary the bridge writes for the control-plane", { timeout: 15_000 }, () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.shutdown();
    harness = undefined;
  });

  specTest("ACP-TURN-049", "writes the summary through /compact once and keeps it out of the chat", async (row) => {
    harness = await makeHarness({ realSummary: true });
    const h = harness;
    const { dispatcher, manager } = h;

    expect(await dispatcher.handleMessage("doc-qa", "111", "first")).toEqual({ ok: true });
    const sessionId = manager.currentSessionId("doc-qa", "111");

    const { status, body } = await h.summarise({
      agent_id: "doc-qa",
      user_id: "111",
      session_id: sessionId,
    });
    expect(status).toBe(202);
    expect(body).toEqual({ status: "accepted" });
    // The answer does not wait for the summary.
    expect(h.summaries).toEqual([]);

    await h.waitUntil(() => h.summaries.length === 1, "the summary to reach the rolling summary");

    expect(h.prompts()).toEqual(["first", SUMMARY_COMMAND]);
    const compactSteps = h
      .readLog()
      .filter((entry) => entry.taken.some((taken) => personPart(taken) === SUMMARY_COMMAND));
    expect(compactSteps).toHaveLength(1);
    expect(h.summaries).toEqual([["doc-qa", "answer to: /compact"]]);
    expect(h.sent.some((text) => text.includes(SUMMARY_COMMAND))).toBe(false);
    expect(answers(h.sent)).toEqual(["answer to: first"]);
    expect(manager.currentSessionId("doc-qa", "111")).toBe(sessionId);

    expect(await dispatcher.handleMessage("doc-qa", "111", "second")).toEqual({ ok: true });
    expect(h.prompts()).toEqual(["first", SUMMARY_COMMAND, "second"]);

    const n = h.prompts().filter((text) => text === SUMMARY_COMMAND).length;
    const kept = h.summaries.some(([, summary]) => summary === "answer to: /compact");
    const inChat = h.sent.some((text) => text.includes(SUMMARY_COMMAND));
    const observed = `the session is sent /compact ${n === 1 ? "once" : `${n} times`}, the summary ${kept ? "reaches the rolling summary" : "does not reach the rolling summary"}, and the chat ${inChat ? "receives it" : "receives none of it"}`;
    expect(observed).toBe(row.expect);
  });

  specTest(
    "ACP-TURN-050",
    "lets a message written during the summary wait for it, and answers it once, unmarked",
    async (row) => {
      harness = await makeHarness({ realSummary: true });
      const h = harness;
      const { dispatcher, manager } = h;

      expect(await dispatcher.handleMessage("doc-qa", "111", "first")).toEqual({ ok: true });
      const sessionId = manager.currentSessionId("doc-qa", "111");
      const { status, body } = await h.summarise({
        agent_id: "doc-qa",
        user_id: "111",
        session_id: sessionId,
      });
      expect(status).toBe(202);
      expect(body).toEqual({ status: "accepted" });

      await h.waitFor(
        (entries) => entries.some((entry) => entry.taken.some((taken) => personPart(taken) === SUMMARY_COMMAND)),
        "the summary to take /compact",
      );

      const second = dispatcher.handleMessage("doc-qa", "111", "second");
      expect(await second).toEqual({ ok: true });

      expect(h.prompts()).toEqual(["first", SUMMARY_COMMAND, "second"]);
      expect(personMessages(h.readSession(), "second")).toHaveLength(1);
      expect(answers(h.sent)).toEqual(["answer to: first", "answer to: second"]);

      const entries = h.readLog();
      const summaryLoop = entries.find((entry) =>
        entry.taken.some((taken) => personPart(taken) === SUMMARY_COMMAND),
      )!.loop;
      const secondSteps = entries.filter((entry) => entry.taken.some((taken) => personPart(taken) === "second"));
      expect(secondSteps).toHaveLength(1);
      expect(secondSteps[0]!.loop).toBeGreaterThan(summaryLoop);

      const rawSecond = h.rawPrompts().find((line) => personPart(line) === "second");
      expect(rawSecond).toBeDefined();
      expect(rawSecond).not.toContain("written_during_previous_work=");
      expect(h.summaries).toEqual([["doc-qa", "answer to: /compact"]]);

      const joined = entries.some(
        (entry) => entry.loop === summaryLoop && entry.taken.some((taken) => personPart(taken) === "second"),
      );
      const waited = !joined && secondSteps[0]!.loop > summaryLoop;
      const n = answers(h.sent).filter((text) => text === "answer to: second").length;
      const marked = (rawSecond ?? "").includes("written_during_previous_work=");
      const observed = `the message ${waited ? "waits for the summary" : "joins the summary"}, is answered ${n === 1 ? "once" : `${n} times`} after it, and ${marked ? "is marked as written during earlier work" : "is not marked as written during earlier work"}`;
      expect(observed).toBe(row.expect);
    },
  );

  specTest("ACP-TURN-051", "refuses a session it only remembers to resume", async (row) => {
    harness = await makeHarness({ realSummary: true });
    const h = harness;
    const { dispatcher, manager } = h;

    expect(await dispatcher.handleMessage("doc-qa", "111", "first")).toEqual({ ok: true });
    const sessionId = manager.currentSessionId("doc-qa", "111");
    manager.killAgentSessions("doc-qa");

    expect(manager.currentSessionId("doc-qa", "111")).toBeUndefined();
    expect(manager.activeSessionCount()).toBe(0);
    expect(manager.resumableSessionCount()).toBe(1);

    const { status, body } = await h.summarise({
      agent_id: "doc-qa",
      user_id: "111",
      session_id: sessionId,
    });
    expect(status).toBe(404);
    expect(body).toEqual({ error: "unknown_session" });

    await sleep(300);
    expect(manager.activeSessionCount()).toBe(0);
    expect(h.prompts()).toEqual(["first"]);
    expect(h.summaries).toEqual([]);

    const started = manager.activeSessionCount() > 0 || h.prompts().length > 1;
    const observed = `the bridge answers ${status} ${body.error} and ${started ? "starts a session" : "starts no session"}`;
    expect(observed).toBe(row.expect);
  });

  specTest("ACP-TURN-052", "ends no session before the summary is written when the bridge stops", async (row) => {
    harness = await makeHarness({ realSummary: true });
    const h = harness;
    const { dispatcher, manager } = h;

    expect(await dispatcher.handleMessage("doc-qa", "111", "first")).toEqual({ ok: true });
    const sessionId = manager.currentSessionId("doc-qa", "111");
    const { status, body } = await h.summarise({
      agent_id: "doc-qa",
      user_id: "111",
      session_id: sessionId,
    });
    expect(status).toBe(202);
    expect(body).toEqual({ status: "accepted" });
    await h.waitFor(
      (entries) => entries.some((entry) => entry.taken.some((taken) => personPart(taken) === SUMMARY_COMMAND)),
      "the summary to take /compact",
    );

    const second = dispatcher.handleMessage("doc-qa", "111", "second");
    await h.waitUntil(() => manager.turnsInFlight("doc-qa") >= 2, "the second message to wait behind the summary");

    const report = await dispatcher.stop({
      limitMs: 50,
      noticeMs: 2_000,
      endSessions: async () => {
        h.events.push("endSessions");
        await manager.shutdown();
      },
    });

    // Before anything else: the summary is written when stop returns.
    expect(h.summaries).toEqual([["doc-qa", "answer to: /compact"]]);

    await manager.shutdown();
    expect(await second).toEqual({ ok: true });

    const endedAt = h.events.indexOf("endSessions");
    const writtenAt = h.events.indexOf("summary");
    expect(writtenAt).toBeGreaterThanOrEqual(0);
    expect(endedAt === -1 || endedAt > writtenAt).toBe(true);
    expect(h.prompts()).toEqual(["first", SUMMARY_COMMAND]);
    expect(h.kept()).toEqual(["second"]);
    expect(report).toBeDefined();

    const endedBefore = endedAt !== -1 && (writtenAt === -1 || endedAt < writtenAt);
    const written = h.summaries.some(([, summary]) => summary === "answer to: /compact");
    const observed = `the bridge ${endedBefore ? "ends a session before the summary is written" : "ends no session before the summary is written"}, and the summary ${written ? "reaches the rolling summary" : "is lost"}`;
    expect(observed).toBe(row.expect);
  });
});

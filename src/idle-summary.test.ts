// The control-plane asks the bridge to summarise a person's idle session
// through POST /internal/summarise. The bridge refuses while a turn of that
// conversation runs, while one of its messages waits for its turn, or while a
// message is still being checked; otherwise it accepts, writes the summary,
// and holds the conversation's order until the summary settles.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isAllowed } from "./allowlist.js";
import type { BridgeConfig } from "./config.js";
import { Dispatcher, type DispatcherDeps } from "./dispatcher.js";
import { type InternalServer, startInternalServer } from "./internal-server.js";
import { SessionManager } from "./session-manager.js";
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

interface Harness {
  dispatcher: Dispatcher;
  manager: SessionManager;
  base: string;
  sent: string[];
  summaryCalls: Array<[string, string]>;
  readLog: () => ModelLogEntry[];
  prompts: () => string[];
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
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "cerase-idle-summary-"));
  const modelLog = join(dir, "model.log");
  const promptLog = join(dir, "prompts.log");
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
  const summaryResolvers: Array<() => void> = [];

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

  const deps: DispatcherDeps & { writeSummary: (agentId: string, userId: string) => Promise<void> } = {
    config,
    sessionManager: manager,
    turnMeta: new TurnMetaTracker(),
    resolveSendTarget: () => async (text) => {
      sent.push(text);
      return { ok: true };
    },
    creditCheck,
    writeSummary,
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
    readLog,
    prompts,
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

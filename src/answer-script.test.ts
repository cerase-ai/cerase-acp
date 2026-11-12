// The rule that holds back an answer whose letters are mostly in another
// writing system than the person's own words, and the one more try the bridge
// gives the assistant in the conversation's language.
//
// The examples are cerase-core's, the file its console suite reads, vendored
// here and pinned in scripts/TOOLING.sha256: the bridge and the console apply
// one rule, so they are held to one set of examples rather than two that could
// drift apart.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MIN_OTHER_LETTERS,
  OTHER_SCRIPT_RETRY_MARKER,
  otherScriptRetryPrompt,
  personWritesLatin,
  withoutHeldPart,
} from "./answer-script.js";
import type { BridgeConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import type { SessionManager, SessionUpdateHandler } from "./session-manager.js";
import { TurnMetaTracker } from "./turn-meta.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = "control-plane/tests/fixtures/answer-script.json";

interface Example {
  name: string;
  person: string;
  answer: string;
  shown: string;
}

interface Fixture {
  min_letters: number;
  cases: Example[];
}

const fixture = JSON.parse(readFileSync(join(repoRoot, FIXTURE), "utf8")) as Fixture;

function exampleNamed(name: string): Example {
  const found = fixture.cases.find((entry) => entry.name === name);
  if (!found) throw new Error(`no fixture case named ${name}`);
  return found;
}

describe("the rule: an answer mostly in another writing system", () => {
  it("holds back at least the number of letters the examples set", () => {
    expect(MIN_OTHER_LETTERS).toBe(fixture.min_letters);
  });

  for (const example of fixture.cases) {
    it(example.name, () => {
      if (personWritesLatin(example.person)) {
        expect(withoutHeldPart(example.answer)).toBe(example.shown);
      } else {
        expect(example.answer).toBe(example.shown);
      }
    });
  }
});

describe("the follow-up after an answer held back for its writing system", () => {
  it("opens with the line that marks it as the bridge's", () => {
    expect(OTHER_SCRIPT_RETRY_MARKER).toBe("[reply_result: other script]");
  });

  it("asks for the conversation's language, or names it when there is none", () => {
    expect(otherScriptRetryPrompt("unknown")).toContain("the language the person writes in");
    expect(otherScriptRetryPrompt("it")).toContain("Italian");
    expect(otherScriptRetryPrompt("en")).toContain("English");
    expect(otherScriptRetryPrompt("es")).toContain("Spanish");
    expect(otherScriptRetryPrompt("fr")).toContain("French");
    for (const lang of ["unknown", "it", "en", "es", "fr"] as const) {
      expect(otherScriptRetryPrompt(lang).split("\n")[0]).toBe(OTHER_SCRIPT_RETRY_MARKER);
    }
  });
});

type Update = Parameters<SessionUpdateHandler>[0];

const CONFIG: BridgeConfig = {
  agents: [
    {
      id: "a",
      channel: "discord",
      cwd: "/home/agent/cerase/workspace",
      mode: "cerase",
      bot_token: "x",
      allowed_users: ["u"],
      spawn: { command: "true", args: [] },
    },
  ],
  session: { idle_timeout_minutes: 60, max_concurrent: 4 },
};

/** One assistant message of a scripted reply: its text, then any tool call it makes. */
interface Step {
  text?: string;
  tool?: string;
}

/**
 * A session that answers each prompt with the script for it, one assistant
 * message per step, as opencode streams a turn: text chunks under the step's
 * message id, then the tool call. Prompts run one at a time, in the order they
 * reach it, and each is recorded.
 */
function session(script: (prompt: string, n: number) => Step[]) {
  const prompts: string[] = [];
  let busy: Promise<void> = Promise.resolve();
  let msg = 0;
  const mgr = {
    async prompt(_agentId: string, _userId: string, text: string, onUpdate?: SessionUpdateHandler) {
      const run = busy.then(async () => {
        const n = prompts.length;
        prompts.push(text);
        for (const step of script(text, n)) {
          msg += 1;
          if (step.text) {
            for (let i = 0; i < step.text.length; i += 7) {
              onUpdate?.({
                sessionUpdate: "agent_message_chunk",
                messageId: `msg_${msg}`,
                content: { type: "text", text: step.text.slice(i, i + 7) },
              } as Update);
              await new Promise((r) => setImmediate(r));
            }
          }
          if (step.tool) {
            onUpdate?.({ sessionUpdate: "tool_call", toolCallId: `call_${msg}`, title: step.tool } as Update);
            onUpdate?.({
              sessionUpdate: "tool_call_update",
              toolCallId: `call_${msg}`,
              status: "completed",
            } as Update);
            await new Promise((r) => setImmediate(r));
          }
        }
      });
      busy = run.catch(() => undefined);
      await run;
      return { stopReason: "end_turn" };
    },
    holdTurn: () => () => {},
  } as unknown as SessionManager;
  return { mgr, prompts };
}

/** `whole` stands for a channel that takes each answer as one message. */
function dispatcher(mgr: SessionManager, sent: string[], whole = false) {
  return new Dispatcher({
    config: CONFIG,
    sessionManager: mgr,
    turnMeta: new TurnMetaTracker(),
    wholeAnswers: () => (whole ? { split: (text) => [text] } : undefined),
    resolveSendTarget: () => async (chunk) => {
      sent.push(chunk);
      return { ok: true };
    },
  });
}

async function turn(script: (prompt: string, n: number) => Step[], message: string, whole = false) {
  const { mgr, prompts } = session(script);
  const sent: string[] = [];
  const result = await dispatcher(mgr, sent, whole).handleMessage("a", "u", message);
  return { result, prompts, sent, chat: sent.join("\n") };
}

const ORDERS = exampleNamed("an answer in Chinese after tool results, to a person writing Italian");
const CHINESE_PERSON = exampleNamed("a person writing Chinese gets an answer in Chinese");
const SHORT_LINE = exampleNamed("a short line in Chinese, under the limit");

const ITALIAN_SENTENCE = "Controllo subito gli ordini di oggi.";
const ITALIAN_ANSWER = "Oggi sono partiti tre ordini; il quarto è ancora in lavorazione.";
const HAN = /\p{Script=Han}/u;

describe("an answer held back for its writing system, on a channel that streams", () => {
  it("holds the Chinese answer back and sends the retry in Italian", async () => {
    const { prompts, sent, chat } = await turn(
      (_prompt, n) =>
        n === 0
          ? [{ text: ITALIAN_SENTENCE, tool: "check_orders" }, { text: ORDERS.answer }]
          : [{ text: ITALIAN_ANSWER }],
      ORDERS.person,
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.split("\n")[0]).toBe(OTHER_SCRIPT_RETRY_MARKER);
    expect(prompts[1]).toContain("Italian");
    expect(sent).toContain(ITALIAN_SENTENCE);
    expect(chat).not.toMatch(HAN);
    expect(chat).toContain(ITALIAN_ANSWER);
  });

  it("shows a second answer in Chinese as it is, and asks no third time", async () => {
    const { prompts, sent } = await turn(
      (_prompt, n) =>
        n === 0
          ? [{ text: ITALIAN_SENTENCE, tool: "check_orders" }, { text: ORDERS.answer }]
          : [{ text: ORDERS.answer }],
      ORDERS.person,
    );
    expect(prompts).toHaveLength(2);
    expect(sent).toContain(ORDERS.answer);
  });

  it("sends a Chinese answer to a person writing Chinese, and does not ask again", async () => {
    const { prompts, sent } = await turn(() => [{ text: CHINESE_PERSON.answer }], CHINESE_PERSON.person);
    expect(prompts).toHaveLength(1);
    expect(sent).toContain(CHINESE_PERSON.answer);
  });

  it("holds back a Chinese message that a later Italian answer follows, and does not ask again", async () => {
    const { prompts, sent, chat } = await turn(
      () => [{ text: ORDERS.answer, tool: "check_orders" }, { text: ITALIAN_ANSWER }],
      ORDERS.person,
    );
    expect(prompts).toHaveLength(1);
    expect(chat).not.toMatch(HAN);
    expect(chat).toContain(ITALIAN_ANSWER);
    expect(sent).toEqual([ITALIAN_ANSWER]);
  });

  it("sends a short line in Chinese whole, and does not ask again", async () => {
    const { prompts, sent } = await turn(() => [{ text: SHORT_LINE.answer }], SHORT_LINE.person);
    expect(prompts).toHaveLength(1);
    expect(sent.join("\n").replace(/\s+/g, " ")).toBe(SHORT_LINE.answer.replace(/\s+/g, " "));
  });
});

describe("an answer held back for its writing system, on a channel that takes each answer as one message", () => {
  it("holds the Chinese answer back and sends the retry in Italian", async () => {
    const { prompts, sent, chat } = await turn(
      (_prompt, n) =>
        n === 0
          ? [{ text: ITALIAN_SENTENCE, tool: "check_orders" }, { text: ORDERS.answer }]
          : [{ text: ITALIAN_ANSWER }],
      ORDERS.person,
      true,
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.split("\n")[0]).toBe(OTHER_SCRIPT_RETRY_MARKER);
    expect(prompts[1]).toContain("Italian");
    expect(sent).toEqual([ITALIAN_SENTENCE, ITALIAN_ANSWER]);
    expect(chat).not.toMatch(HAN);
  });

  it("shows a second answer in Chinese as it is, and asks no third time", async () => {
    const { prompts, sent } = await turn(
      (_prompt, n) =>
        n === 0
          ? [{ text: ITALIAN_SENTENCE, tool: "check_orders" }, { text: ORDERS.answer }]
          : [{ text: ORDERS.answer }],
      ORDERS.person,
      true,
    );
    expect(prompts).toHaveLength(2);
    expect(sent).toEqual([ITALIAN_SENTENCE, ORDERS.answer]);
  });

  it("sends a Chinese answer to a person writing Chinese, and does not ask again", async () => {
    const { prompts, sent } = await turn(() => [{ text: CHINESE_PERSON.answer }], CHINESE_PERSON.person, true);
    expect(prompts).toHaveLength(1);
    expect(sent).toEqual([CHINESE_PERSON.answer]);
  });

  it("holds back a Chinese message that a later Italian answer follows, and does not ask again", async () => {
    const { prompts, sent, chat } = await turn(
      () => [{ text: ORDERS.answer, tool: "check_orders" }, { text: ITALIAN_ANSWER }],
      ORDERS.person,
      true,
    );
    expect(prompts).toHaveLength(1);
    expect(sent).toEqual([ITALIAN_ANSWER]);
    expect(chat).not.toMatch(HAN);
  });

  it("sends a short line in Chinese whole, and does not ask again", async () => {
    const { prompts, sent } = await turn(() => [{ text: SHORT_LINE.answer }], SHORT_LINE.person, true);
    expect(prompts).toHaveLength(1);
    expect(sent).toEqual([SHORT_LINE.answer]);
  });
});

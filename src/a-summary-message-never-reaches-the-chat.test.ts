import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import { isInternalSummaryBlock } from "./egress-redaction.js";
import { execMessageKindProbe, type MessageKind, SLOT_REST_SCRIPT, type SlotExec } from "./opencode-rest.js";
import type { SessionManager, SessionUpdateHandler } from "./session-manager.js";
import { TurnMetaTracker } from "./turn-meta.js";

type Update = Parameters<SessionUpdateHandler>[0];

function smwConfig(): BridgeConfig {
  return {
    agents: [
      {
        id: "doc-qa",
        channel: "discord",
        cwd: "/home/agent/cerase/workspace",
        mode: "cerase",
        bot_token: "irrelevant",
        allowed_users: ["111"],
        spawn: { command: "node", args: ["unused"] },
      },
    ],
    session: { idle_timeout_minutes: 60, max_concurrent: 16 },
  };
}

// A summary opencode wrote without any of the template's headings. It is
// still a summary, and the message it belongs to is what says so.
const SUMMARY =
  "[Assistant reasoning]: Ha confermato il totale, devo mandare la mail al responsabile acquisti prima di " +
  "venerdì. Le tre offerte sono state lette e la seconda resta la più conveniente, anche se i tempi di " +
  "consegna sono più lunghi. Ho già preparato la tabella con prezzi, tempi e condizioni di pagamento, e " +
  "manca solo il listino del terzo fornitore per chiudere il confronto. Il totale confermato è di " +
  "quarantamila euro, IVA esclusa, e va indicato nella mail insieme alla scadenza. Devo anche ricordare " +
  "al responsabile che la prima offerta include l'installazione e che la terza chiede il pagamento anticipato.";

const ANSWER =
  "Ecco il confronto che mi avevi chiesto: la seconda offerta è la più conveniente, la prima la più veloce.";

const squash = (s: string) => s.replace(/\s+/g, "");

/** The reply as the agent streams it: pieces of about fifty characters. */
function smwChunked(text: string, messageId?: string, size = 50): Update[] {
  const out: Update[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: text.slice(i, i + size) },
      ...(messageId ? { messageId } : {}),
    } as Update);
  }
  return out;
}

type KindAnswer = MessageKind | null | Error | { delayMs: number; kind: MessageKind | null };

/** A `messageKind` stub answering from a map, counting the calls per message id. */
function smwKindProbe(answers: Record<string, KindAnswer>) {
  const calls: Record<string, number> = {};
  const messageKind = async (_agentId: string, _userId: string, messageId: string): Promise<MessageKind | null> => {
    calls[messageId] = (calls[messageId] ?? 0) + 1;
    const answer = answers[messageId];
    if (answer instanceof Error) throw answer;
    if (answer !== null && typeof answer === "object" && "delayMs" in answer) {
      await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
      return answer.kind;
    }
    return answer ?? null;
  };
  return { messageKind, calls };
}

/**
 * A session manager that streams `updates` one event-loop turn apart, then
 * waits `endAfterMs`, snapshots what reached the chat, and ends the turn.
 */
function smwManager(
  updates: Update[],
  after: () => void,
  messageKind: (agentId: string, userId: string, messageId: string) => Promise<MessageKind | null>,
  opts: { fail?: Error; endAfterMs?: number } = {},
): SessionManager {
  return {
    async prompt(_agentId: string, _userId: string, _text: string, onUpdate?: SessionUpdateHandler) {
      for (const u of updates) {
        onUpdate?.(u);
        await new Promise((r) => setImmediate(r));
      }
      await new Promise((r) => setTimeout(r, opts.endAfterMs ?? 400));
      after();
      if (opts.fail) throw opts.fail;
      return { stopReason: "end_turn" };
    },
    messageKind,
  } as unknown as SessionManager;
}

function smwHarness(
  updates: Update[],
  answers: Record<string, KindAnswer> = {},
  opts: { fail?: Error; whole?: boolean; endAfterMs?: number } = {},
) {
  const delivered: string[] = [];
  const withheld: string[] = [];
  let duringTurn: string[] = [];
  const { messageKind, calls } = smwKindProbe(answers);
  const d = new Dispatcher({
    config: smwConfig(),
    sessionManager: smwManager(updates, () => (duringTurn = [...delivered]), messageKind, opts),
    turnMeta: new TurnMetaTracker(),
    wholeAnswers: () => (opts.whole ? { split: (text: string) => [text] } : undefined),
    onSummaryWithheld: (_agentId, summary) => withheld.push(summary),
    resolveSendTarget: () => async (chunk) => {
      if (!isInternalSummaryBlock(chunk)) delivered.push(chunk);
      return { ok: true };
    },
  });
  return { d, delivered, withheld, calls, duringTurn: () => duringTurn };
}

function smwRecording(stdout: string, ok = true): { exec: SlotExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: SlotExec = async (args) => {
    calls.push(args);
    return { stdout, ok };
  };
  return { exec, calls };
}

describe("execMessageKindProbe", () => {
  const probe = (body: unknown, ok = true) =>
    execMessageKindProbe(smwRecording(`${JSON.stringify(body)}\n200`, ok).exec)("cerase-agent-3", "ses_a", "msg_1");

  it("reads each of the three summary signals as a summary", async () => {
    await expect(probe({ info: { role: "assistant", summary: true } })).resolves.toBe("summary");
    await expect(probe({ info: { role: "assistant", mode: "compaction" } })).resolves.toBe("summary");
    await expect(probe({ info: { role: "assistant", agent: "compaction" } })).resolves.toBe("summary");
  });

  it("reads a plain assistant message as an answer", async () => {
    await expect(probe({ info: { role: "assistant", mode: "cerase", agent: "cerase" } })).resolves.toBe("answer");
  });

  it("answers null for a person's message, a body that is not JSON, and a body without info", async () => {
    await expect(probe({ info: { role: "user" } })).resolves.toBeNull();
    await expect(
      execMessageKindProbe(smwRecording("<html>\n200").exec)("cerase-agent-3", "ses_a", "msg_1"),
    ).resolves.toBeNull();
    await expect(probe({ parts: [] })).resolves.toBeNull();
  });

  it("asks the slot for the message with both ids URL-encoded, the path as an argument", async () => {
    const { exec, calls } = smwRecording(`${JSON.stringify({ info: { role: "assistant" } })}\n200`);

    await execMessageKindProbe(exec)("cerase-agent-3", "ses_$(id)", "msg_1;x");

    expect(calls).toEqual([
      ["exec", "cerase-agent-3", "sh", "-c", SLOT_REST_SCRIPT, "sh", "/session/ses_%24(id)/message/msg_1%3Bx"],
    ]);
  });
});

describe("a summary message never reaches the chat", () => {
  for (const whole of [false, true]) {
    const channel = whole ? "on a channel that takes each answer as one message" : "on a streamed channel";

    describe(channel, () => {
      it("withholds a summary with no headings and delivers only the answer that follows it", async () => {
        expect(SUMMARY.length).toBeGreaterThanOrEqual(300);
        expect(SUMMARY).not.toMatch(/^\s*#{1,4}\s/m);
        expect(isInternalSummaryBlock(SUMMARY)).toBe(false);

        const h = smwHarness(
          [...smwChunked(SUMMARY, "msg_compaction"), ...smwChunked(ANSWER, "msg_answer")],
          { msg_compaction: "summary", msg_answer: "answer" },
          { whole },
        );

        await expect(h.d.handleMessage("doc-qa", "111", "ciao")).resolves.toEqual({ ok: true });
        expect(squash(h.delivered.join(""))).toBe(squash(ANSWER));
        if (whole) expect(h.delivered).toEqual([ANSWER]);
        expect(h.withheld).toEqual([SUMMARY]);
        expect(h.calls).toEqual({ msg_compaction: 1, msg_answer: 1 });
      });

      it("still withholds the summary when its kind answers after 200 ms", async () => {
        const h = smwHarness(
          [...smwChunked(SUMMARY, "msg_compaction"), ...smwChunked(ANSWER, "msg_answer")],
          { msg_compaction: { delayMs: 200, kind: "summary" }, msg_answer: "answer" },
          { whole, endAfterMs: 20 },
        );

        await expect(h.d.handleMessage("doc-qa", "111", "ciao")).resolves.toEqual({ ok: true });
        expect(squash(h.delivered.join(""))).toBe(squash(ANSWER));
        if (whole) expect(h.delivered).toEqual([ANSWER]);
        expect(h.withheld).toEqual([SUMMARY]);
      });

      it("delivers an answer whole when its kind answers after 200 ms, and withholds nothing", async () => {
        const h = smwHarness(
          smwChunked(ANSWER, "msg_answer"),
          { msg_answer: { delayMs: 200, kind: "answer" } },
          { whole, endAfterMs: 20 },
        );

        await expect(h.d.handleMessage("doc-qa", "111", "ciao")).resolves.toEqual({ ok: true });
        expect(squash(h.delivered.join(""))).toBe(squash(ANSWER));
        if (whole) expect(h.delivered).toEqual([ANSWER]);
        expect(h.withheld).toEqual([]);
      });

      it("delivers a headless summary when the kind lookup throws, never withholding an answer on a failure", async () => {
        const h = smwHarness(
          smwChunked(SUMMARY, "msg_compaction"),
          { msg_compaction: new Error("the slot did not answer") },
          { whole },
        );

        await expect(h.d.handleMessage("doc-qa", "111", "ciao")).resolves.toEqual({ ok: true });
        expect(squash(h.delivered.join(""))).toBe(squash(SUMMARY));
        if (whole) expect(h.delivered).toEqual([SUMMARY]);
        expect(h.withheld).toEqual([]);
      });

      it("delivers a headless summary when the kind lookup answers null", async () => {
        const h = smwHarness(smwChunked(SUMMARY, "msg_compaction"), { msg_compaction: null }, { whole });

        await expect(h.d.handleMessage("doc-qa", "111", "ciao")).resolves.toEqual({ ok: true });
        expect(squash(h.delivered.join(""))).toBe(squash(SUMMARY));
        if (whole) expect(h.delivered).toEqual([SUMMARY]);
        expect(h.withheld).toEqual([]);
      });

      it("never asks for a kind when the chunks carry no message id, and delivers the answer", async () => {
        const h = smwHarness(smwChunked(ANSWER), {}, { whole });

        await expect(h.d.handleMessage("doc-qa", "111", "ciao")).resolves.toEqual({ ok: true });
        expect(squash(h.delivered.join(""))).toBe(squash(ANSWER));
        if (whole) expect(h.delivered).toEqual([ANSWER]);
        expect(h.calls).toEqual({});
        expect(h.withheld).toEqual([]);
      });

      it("keeps a chunk without a message id after the text of a message still being judged", async () => {
        const TAIL = " Ti mando il dettaglio entro domani mattina.";
        const h = smwHarness(
          [...smwChunked(ANSWER, "msg_answer"), ...smwChunked(TAIL)],
          { msg_answer: { delayMs: 200, kind: "answer" } },
          { whole },
        );

        await expect(h.d.handleMessage("doc-qa", "111", "ciao")).resolves.toEqual({ ok: true });
        expect(squash(h.delivered.join(""))).toBe(squash(ANSWER + TAIL));
        expect(h.withheld).toEqual([]);
      });

      it("asks for a message's kind once, however many chunks carry its id", async () => {
        const h = smwHarness(
          [...smwChunked(SUMMARY, "msg_compaction", 20), ...smwChunked(ANSWER, "msg_answer", 20)],
          { msg_compaction: "summary", msg_answer: "answer" },
          { whole },
        );

        await expect(h.d.handleMessage("doc-qa", "111", "ciao")).resolves.toEqual({ ok: true });
        expect(h.calls).toEqual({ msg_compaction: 1, msg_answer: 1 });
        expect(h.withheld).toEqual([SUMMARY]);
        expect(squash(h.delivered.join(""))).toBe(squash(ANSWER));
      });
    });
  }
});

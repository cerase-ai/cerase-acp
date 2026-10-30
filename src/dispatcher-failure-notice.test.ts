import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import { type SessionManager, TurnWatchdogError } from "./session-manager.js";
import { TurnMetaTracker } from "./turn-meta.js";

// A failed turn tells the person what happened. A scheduled message has no
// one reading the bridge's result, so the same copy travels back on the failed
// DeliveryResult for the caller to report to the control-plane.

function cfg(): BridgeConfig {
  return {
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
    locale: "it",
  };
}

function failing(error: Error, updates: unknown[] = []): SessionManager {
  return {
    prompt: async (_agentId: string, _userId: string, _text: string, onUpdate?: (u: unknown) => void) => {
      for (const u of updates) onUpdate?.(u);
      throw error;
    },
  } as unknown as SessionManager;
}

type FailureResult = {
  ok: boolean;
  notice?: string;
  error?: Error;
  retryable?: boolean;
};

type FailureOptions = {
  byPerson?: boolean;
  holdFailureCopy?: boolean;
  failureLabel?: string;
};

async function failedTurn(
  error: Error,
  opts: { text?: string; options?: FailureOptions; updates?: unknown[] } = {},
): Promise<{
  result: FailureResult;
  sent: string[];
}> {
  const sent: string[] = [];
  const d = new Dispatcher({
    config: cfg(),
    sessionManager: failing(error, opts.updates),
    turnMeta: new TurnMetaTracker(),
    resolveSendTarget: () => async (text) => {
      sent.push(text);
      return { ok: true };
    },
  });
  const result = (await d.handleMessage(
    "a",
    "u",
    opts.text ?? "controlla la posta",
    undefined,
    opts.options,
  )) as FailureResult;
  return { result, sent };
}

describe("a failed turn reports the copy the person was sent", () => {
  it("carries the failure copy when the watchdog ended a silent turn", async () => {
    const copy = "Si è verificato un errore, riprova tra poco.";
    const { result, sent } = await failedTurn(new TurnWatchdogError("silent", 180_000));

    expect(result.ok).toBe(false);
    expect(result.notice).toBe(copy);
    expect(sent).toContain(copy);
  });

  it("carries the too-long copy when the watchdog ended a turn at its ceiling", async () => {
    const copy =
      "Ci stavo lavorando ma ho superato il tempo massimo per una singola richiesta. Prova a spezzarla in due, oppure chiedimi la parte che ti serve per prima.";
    const { result, sent } = await failedTurn(new TurnWatchdogError("ceiling", 2_700_000));

    expect(result.ok).toBe(false);
    expect(result.notice).toBe(copy);
    expect(sent).toContain(copy);
  });
});

// A scheduled message's caller may try a generic failure once more. The first
// try holds the failure copy so the person does not hear about it yet; only a
// second failure is sent, naming the scheduled message that did not run.
describe("a scheduled turn's failure is held for one retry", () => {
  it("sends nothing and says the turn is retryable when the caller holds the failure copy", async () => {
    const { result, sent } = await failedTurn(new Error("opencode crashed"), {
      options: { holdFailureCopy: true },
    });

    expect(sent).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.notice).toBeUndefined();
    expect(result.error?.message).toBe("opencode crashed");
  });

  it("still sends the no-credits copy, and no retryable, when the credits are exhausted", async () => {
    const copy =
      "I crediti dell'organizzazione sono esauriti — avvisa il tuo amministratore, che può chiederne altri a Cerase.";
    const { result, sent } = await failedTurn(new Error("cerase credit gate: credits exhausted"), {
      options: { holdFailureCopy: true },
    });

    expect(sent).toContain(copy);
    expect(result.notice).toBe(copy);
    expect(result.retryable).not.toBe(true);
  });

  it("names the scheduled message in the Italian second-failure copy", async () => {
    const copy = "Non sono riuscito a completare «Rassegna», nemmeno riprovando.";
    const { result, sent } = await failedTurn(new Error("opencode crashed"), {
      options: { failureLabel: "Rassegna" },
    });

    expect(sent).toEqual([copy]);
    expect(result.notice).toBe(copy);
  });

  it("names the scheduled message in the English second-failure copy", async () => {
    const copy = 'I could not complete "Rassegna", even on a second try.';
    const { result, sent } = await failedTurn(new Error("opencode crashed"), {
      text: "hello, can you help me summarise the document?",
      options: { failureLabel: "Rassegna" },
    });

    expect(sent).toEqual([copy]);
    expect(result.notice).toBe(copy);
  });

  // A try that ran a tool did something, and running the turn again would do
  // it twice: a scheduled triage that sent a mail and then failed would send
  // it again. The same rule as the empty-turn retry, which asks again only a
  // turn that neither ran a tool nor wrote anything.
  it("sends the failure copy and is not retryable when the failed try ran a tool", async () => {
    const copy = "Si è verificato un errore, riprova tra poco.";
    const { result, sent } = await failedTurn(new Error("opencode crashed"), {
      options: { holdFailureCopy: true },
      updates: [
        { sessionUpdate: "tool_call", toolCallId: "t1", title: "send_email", kind: "other", status: "pending" },
      ],
    });

    expect(sent).toContain(copy);
    expect(result.retryable).not.toBe(true);
  });

  it("sends the failure copy and is not retryable when the failed try already wrote to the person", async () => {
    const copy = "Si è verificato un errore, riprova tra poco.";
    const { result, sent } = await failedTurn(new Error("opencode crashed"), {
      options: { holdFailureCopy: true },
      updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Ecco le mail di oggi:" } }],
    });

    expect(sent).toContain(copy);
    expect(result.retryable).not.toBe(true);
  });

  it("keeps the ordinary failure copy when neither retry option is given", async () => {
    const copy = "Si è verificato un errore, riprova tra poco.";
    const { result, sent } = await failedTurn(new Error("opencode crashed"));

    expect(sent).toEqual([copy]);
    expect(result.notice).toBe(copy);
  });
});

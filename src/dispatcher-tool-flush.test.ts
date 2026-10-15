// The text an assistant streams before a tool call reaches the person as a
// message of its own the moment the tool starts, on every channel, and is never
// glued to the text that follows the tool. Driven through the real dispatcher
// with a session the test holds open: the clock stands still until the test
// moves it, which is how a short tool is expressed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freezeBridgeClock } from "./__tests__/fake-clock.js";
import type { DeliveryResult } from "./chat-adapter.js";
import type { BridgeConfig } from "./config.js";
import { Dispatcher, type DispatcherDeps } from "./dispatcher.js";
import type { PromptOptions, SessionManager, SessionUpdateHandler } from "./session-manager.js";
import { TurnMetaTracker } from "./turn-meta.js";

type Update = Parameters<SessionUpdateHandler>[0];

const CONFIG: BridgeConfig = {
  agents: [
    {
      id: "agent-1",
      channel: "discord",
      cwd: "/home/agent/cerase/workspace",
      mode: "cerase",
      bot_token: "irrelevant",
      allowed_users: ["111"],
      spawn: { command: "true", args: [] },
    },
  ],
  session: { idle_timeout_minutes: 60, max_concurrent: 16 },
};

const BEFORE = "Ho capito: vuoi le mail di Mario di ieri.";
const AFTER = "Ne ho trovate tre.";

// The markdown summary headings the egress filter recognises taken together.
const SUMMARY = [
  "## Objective",
  "- Preparare il riepilogo delle offerte ricevute e inviarlo al responsabile acquisti.",
  "",
  "## Important Details",
  "- Le offerte arrivate sono tre; la scadenza per rispondere è venerdì.",
  "- Il responsabile vuole il confronto in una tabella.",
  "",
  "## Work State",
  "### Completed",
  "- Lette le tre offerte dalla casella condivisa.",
].join("\n");

// A final answer the model wrote out as a tool call instead of making it.
const MARKUP = [
  "<tool_calls>",
  '<invoke name="x">',
  '<parameter name="p">v</parameter>',
  "</invoke>",
  "</tool_calls>",
].join("\n");

interface HeldPrompt {
  text: string;
  update(u: Record<string, unknown>): void;
  say(text: string, messageId?: string): void;
  end(reply?: string): void;
}

const toolCall = (id: string) => ({
  sessionUpdate: "tool_call",
  toolCallId: id,
  title: "webfetch",
  kind: "other",
  status: "pending",
  rawInput: {},
});
const done = (id: string) => ({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });

describe("the text before a tool call", () => {
  let prompts: HeldPrompt[];
  let sent: string[];

  const sessionManager = {
    prompt: (
      _agentId: string,
      _userId: string,
      text: string,
      onUpdate?: (u: Update) => void,
      _options?: PromptOptions,
    ) =>
      new Promise((resolve) => {
        const update = (u: Record<string, unknown>) => onUpdate?.(u as unknown as Update);
        const say = (t: string, messageId?: string) =>
          update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: t },
            ...(messageId ? { messageId } : {}),
          });
        prompts.push({
          text,
          update,
          say,
          end: (reply) => {
            if (reply) say(reply);
            resolve({ stopReason: "end_turn" });
          },
        });
      }),
    holdTurn: () => () => {},
  } as unknown as SessionManager;

  function dispatcher(extra: Partial<DispatcherDeps> = {}): Dispatcher {
    return new Dispatcher({
      config: CONFIG,
      sessionManager,
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget:
        () =>
        async (chunk: string): Promise<DeliveryResult> => {
          sent.push(chunk);
          return { ok: true };
        },
      ...extra,
    });
  }

  const settle = () => vi.advanceTimersByTimeAsync(0);
  const elapse = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const promptCount = (n: number) => vi.waitFor(() => expect(prompts).toHaveLength(n));

  beforeEach(() => {
    freezeBridgeClock();
    prompts = [];
    sent = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is sent as one message the moment the tool starts, with no timer advanced", async () => {
    const turn = dispatcher().handleMessage("agent-1", "111", "cerca le mail di Mario");
    await promptCount(1);
    prompts[0]!.say(BEFORE);
    await settle();
    // Under the sentence threshold and with no timer moved, the buffer still
    // holds it.
    expect(sent).toEqual([]);

    prompts[0]!.update(toolCall("c1"));
    await settle();
    expect(sent).toEqual([BEFORE]);

    prompts[0]!.update(done("c1"));
    prompts[0]!.end("Ecco quello che ho trovato.");
    await elapse(200);
    expect(await turn).toEqual({ ok: true });
    expect(sent).toEqual([BEFORE, "Ecco quello che ho trovato."]);
  });

  it("is not glued to the text after a short tool, with no message id change", async () => {
    const turn = dispatcher().handleMessage("agent-1", "111", "cerca le mail di Mario");
    await promptCount(1);
    prompts[0]!.say(BEFORE);
    prompts[0]!.update(toolCall("c1"));
    // The tool runs for 300 ms, too short for the 500 ms idle timer.
    await elapse(300);
    prompts[0]!.update(done("c1"));
    prompts[0]!.say(AFTER);
    prompts[0]!.end();
    expect(await turn).toEqual({ ok: true });
    await elapse(300);
    expect(sent).toEqual([BEFORE, AFTER]);
    expect(sent.join("\n")).not.toContain(`${BEFORE}${AFTER}`);
  });

  it("on a channel that takes each answer as one message, is its own message too", async () => {
    const whole = () => ({ split: (text: string) => [text] });
    const turn = dispatcher({ wholeAnswers: whole }).handleMessage("agent-1", "111", "cerca le mail di Mario");
    await promptCount(1);
    prompts[0]!.say(BEFORE);
    prompts[0]!.update(toolCall("c1"));
    await settle();
    expect(sent).toEqual([BEFORE]);
    await elapse(300);
    prompts[0]!.update(done("c1"));
    prompts[0]!.say(AFTER);
    prompts[0]!.end();
    expect(await turn).toEqual({ ok: true });
    await elapse(300);
    expect(sent).toEqual([BEFORE, AFTER]);
  });

  it("leaves a tool-call-markup hold in place at the tool call", async () => {
    const turn = dispatcher().handleMessage("agent-1", "111", "cosa hai fatto?");
    await promptCount(1);
    prompts[0]!.say(`Un attimo.\n\n${MARKUP}`, "m1");
    prompts[0]!.update(toolCall("c1"));
    await settle();
    // Only the sentence before the block left; the block itself is still held.
    expect(sent).toEqual(["Un attimo."]);
    expect(sent.join("")).not.toContain("tool_calls");

    // The next message ends the hold: the block is withheld as a call written
    // out, and the real answer reaches the person.
    prompts[0]!.say("Ecco il riepilogo.", "m2");
    prompts[0]!.end();
    await elapse(200);
    expect(await turn).toEqual({ ok: true });
    expect(sent).toEqual(["Un attimo.", "Ecco il riepilogo."]);
  });

  it("leaves a summary hold in place at the tool call", async () => {
    const turn = dispatcher().handleMessage("agent-1", "111", "riassumi la conversazione");
    await promptCount(1);
    prompts[0]!.say(SUMMARY, "m1");
    await settle();
    // Starting at its first heading, the summary is held whole.
    expect(sent).toEqual([]);

    prompts[0]!.update(toolCall("c1"));
    await settle();
    expect(sent).toEqual([]);

    prompts[0]!.say("Ecco il riepilogo.", "m2");
    prompts[0]!.end();
    expect(await turn).toEqual({ ok: true });
    await settle();
    expect(sent).toEqual(["Ecco il riepilogo."]);
    expect(sent.join("")).not.toContain("Objective");
  });
});

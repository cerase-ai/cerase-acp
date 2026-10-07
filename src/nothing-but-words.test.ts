import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import type { SessionManager, SessionUpdateHandler } from "./session-manager.js";
import {
  endsInToolCallMarkup,
  isElementCall,
  isOnlyTags,
  MARKUP_RETRY_MARKER,
  toolCallMarkupHoldStart,
  withheldMarkupStart,
} from "./tool-call-markup.js";
import { TurnMetaTracker } from "./turn-meta.js";

// What Matilde wrote on `guidance` on the evening of 6 October, verbatim from
// her session. The first two reached the operator's chat as written; the third
// was held back and the operator waited; the fourth reached the chat with the
// call in it.
const OCTOBER_6 = {
  tagAlone: "<cerase-ok>",
  dsml:
    "<｜｜DSML｜｜ calls>\n" +
    '<｜｜DSML｜｜ invoke name="cerase-gateway_call_recipe">\n' +
    '<｜｜DSML｜｜ parameter name="recipe_name" string="true">cerase-office-converter.convert_md_to_pdf</｜｜DSML｜｜ parameter>\n' +
    '<｜｜DSML｜｜ parameter name="args" string="false">{"output_filename": "Preventivo-MAGIS-2027-2029.pdf", "path": "/home/agent/cerase/workspace/outputs/preventivo-magis-2027-2029.md"}</｜｜DSML｜｜ parameter>\n' +
    "</｜｜DSML｜｜ invoke>\n" +
    "</｜｜DSML｜｜ calls>",
  apologyWithACall:
    "Chiedo scusa per il messaggio di prima: mi è partito un comando a metà e non ti ho detto nulla. Recupero ora.\n\n" +
    "<cerase-gateway_call_recipe>\n" +
    "<recipe_name>cerase-tasks.set_status</recipe_name>\n" +
    '<args>{"status": "review", "task_id": "01a11314-83c0-7264-8e1c-0ed12d1c78ea"}</args>\n' +
    "</cerase-gateway_call_recipe>",
};

const APOLOGY =
  "Chiedo scusa per il messaggio di prima: mi è partito un comando a metà e non ti ho detto nulla. Recupero ora.";
const ANSWER =
  "Ecco il preventivo, in bozza per la tua revisione: un'offerta unica a nome Guidance per tutto il perimetro.";

// Words a person may well be sent, each beginning a line with an angle bracket.
const WORDS = {
  boldLabel: "<b>Nota</b>: la consegna slitta a lunedì.",
  link: "Il modulo è qui:\n<https://example.com/modulo>",
  address: "Scrivimi a\n<mario.rossi@example.com>",
  callThenProse:
    "<cerase-gateway_call_recipe>\n<recipe_name>x</recipe_name>\n</cerase-gateway_call_recipe>\n\nPoi te lo mando.",
  fenced: "Ecco come si scrive:\n\n```xml\n<cerase-ok>\n```",
};

describe("the rule: text that is not words for a person", () => {
  it("catches a tag written alone", () => {
    expect(isOnlyTags(OCTOBER_6.tagAlone)).toBe(true);
    expect(endsInToolCallMarkup(OCTOBER_6.tagAlone)).toBe(true);
    expect(withheldMarkupStart(OCTOBER_6.tagAlone)).toEqual({ at: 0, kind: "tags" });
  });

  it("catches DeepSeek's markers", () => {
    expect(withheldMarkupStart(OCTOBER_6.dsml)).toEqual({ at: 0, kind: "call" });
  });

  it("catches a call spelled as elements named after the tool, and keeps the sentence before it", () => {
    const found = withheldMarkupStart(OCTOBER_6.apologyWithACall);
    expect(found?.kind).toBe("call");
    expect(OCTOBER_6.apologyWithACall.slice(0, found!.at).trim()).toBe(APOLOGY);
    expect(isElementCall(OCTOBER_6.apologyWithACall.slice(found!.at))).toBe(true);
  });

  it("holds from a line that opens with a tag of any name", () => {
    expect(toolCallMarkupHoldStart(OCTOBER_6.tagAlone)).toBe(0);
    expect(toolCallMarkupHoldStart(OCTOBER_6.apologyWithACall)).toBe(OCTOBER_6.apologyWithACall.indexOf("<cerase"));
  });

  for (const [shape, text] of Object.entries(WORDS)) {
    it(`leaves words alone: ${shape}`, () => {
      expect(withheldMarkupStart(text)).toBeNull();
    });
  }
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
 * reach it, as the session's queue runs them, and each is recorded.
 */
function session(script: (prompt: string, n: number) => Step[], gate?: Promise<void>) {
  const prompts: string[] = [];
  let busy: Promise<void> = Promise.resolve();
  let msg = 0;
  const mgr = {
    async prompt(_agentId: string, _userId: string, text: string, onUpdate?: SessionUpdateHandler) {
      const run = busy.then(async () => {
        const n = prompts.length;
        prompts.push(text);
        if (n === 0 && gate) await gate;
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

function dispatcher(mgr: SessionManager, sent: string[]) {
  return new Dispatcher({
    config: CONFIG,
    sessionManager: mgr,
    turnMeta: new TurnMetaTracker(),
    resolveSendTarget: () => async (chunk) => {
      sent.push(chunk);
      return { ok: true };
    },
  });
}

const VOICE = "[Uploaded files: uploads/1791321425110-0/voice-message.ogg]";

describe("the chat of 6 October, replayed", () => {
  it("a tag written alone before a tool call never reaches the chat", async () => {
    const { mgr } = session(() => [
      { text: OCTOBER_6.tagAlone, tool: "cerase-gateway_call_recipe" },
      { text: OCTOBER_6.tagAlone, tool: "cerase-gateway_call_recipe" },
      { text: ANSWER },
    ]);
    const sent: string[] = [];
    const result = await dispatcher(mgr, sent).handleMessage("a", "u", VOICE);
    expect(sent.join("\n")).not.toContain("cerase-ok");
    expect(sent.join("\n")).toContain(ANSWER);
    expect(result).toEqual({ ok: true });
  });

  it("an answer that is only a tag is held back and the assistant answers again in the same turn", async () => {
    const { mgr, prompts } = session((_p, n) => (n === 0 ? [{ text: OCTOBER_6.tagAlone }] : [{ text: ANSWER }]));
    const sent: string[] = [];
    await dispatcher(mgr, sent).handleMessage("a", "u", VOICE);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.split("\n")[0]).toBe(MARKUP_RETRY_MARKER);
    expect(sent).toEqual([ANSWER]);
  });

  it("an answer held back is answered again before the message the person sent while waiting", async () => {
    // The turn ran for two and a half minutes; the person wrote «??» while it
    // did. The try that answers them must come before «??», not after it.
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const { mgr, prompts } = session(
      (p, n) =>
        n === 0
          ? [
              { text: OCTOBER_6.tagAlone, tool: "cerase-gateway_call_recipe" },
              { tool: "edit" },
              { text: OCTOBER_6.dsml },
            ]
          : p.startsWith(MARKUP_RETRY_MARKER)
            ? [{ tool: "cerase-gateway_call_recipe" }, { text: ANSWER }]
            : [{ text: "Sì, ci sono: il preventivo è pronto qui sopra." }],
      gate,
    );
    const sent: string[] = [];
    const d = dispatcher(mgr, sent);
    const first = d.handleMessage("a", "u", VOICE);
    await new Promise((r) => setImmediate(r));
    const second = d.handleMessage("a", "u", "??");
    await new Promise((r) => setImmediate(r));
    open();
    await Promise.all([first, second]);
    expect(prompts.map((p) => (p.startsWith(MARKUP_RETRY_MARKER) ? "retry" : p.split("\n\n").pop()))).toEqual([
      VOICE,
      "retry",
      "??",
    ]);
    expect(sent[0]).toBe(ANSWER);
    expect(sent.join("\n")).not.toMatch(/DSML|cerase-ok|recipe_name/);
  });

  it("an apology carrying the call again reaches the chat without the call, and the assistant tries again", async () => {
    const { mgr, prompts } = session((_p, n) =>
      n === 0 ? [{ text: OCTOBER_6.apologyWithACall }] : [{ tool: "cerase-gateway_call_recipe" }, { text: ANSWER }],
    );
    const sent: string[] = [];
    const result = await dispatcher(mgr, sent).handleMessage("a", "u", "??");
    expect(sent).toEqual([APOLOGY, ANSWER]);
    expect(prompts).toHaveLength(2);
    expect(result).toEqual({ ok: true });
  });
});

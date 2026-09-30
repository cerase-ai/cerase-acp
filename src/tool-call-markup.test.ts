import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import type { SessionManager, SessionUpdateHandler } from "./session-manager.js";
import {
  endsInToolCallMarkup,
  isToolCallMarkup,
  MARKUP_RETRY_MARKER,
  toolCallMarkupHoldStart,
  toolCallMarkupStart,
} from "./tool-call-markup.js";
import { TurnMetaTracker } from "./turn-meta.js";

// Final answers recorded on the bench, verbatim: one per shape the model
// produced in place of a call.
const RECORDED = {
  dsmlOnly:
    "<｜｜DSML｜｜ calls>\n" +
    '<｜｜DSML｜｜ invoke name="getGoogleSlides">\n' +
    '<｜｜DSML｜｜ parameter name="presentationId" string="true">prs_3ba88f</｜｜DSML｜｜ parameter>\n' +
    "</｜｜DSML｜｜ invoke>\n" +
    "</｜｜DSML｜｜ calls>",
  dsmlAfterASentence:
    "Ora devo mettere titolo e contenuto su ogni slide con formattazione reale. Provo lo strumento dedicato.\n\n" +
    "<｜｜DSML｜｜ calls>\n" +
    '<｜｜DSML｜｜ invoke name="addGoogleSlideText">\n' +
    '<｜｜DSML｜｜ parameter name="presentationId" string="true">prs_3ba88f</｜｜DSML｜｜ parameter>\n' +
    '<｜｜DSML｜｜ parameter name="title" string="true">Il problema</｜｜DSML｜｜ parameter>\n' +
    "</｜｜DSML｜｜ invoke>\n" +
    "</｜｜DSML｜｜ calls>",
  dsmlSingleBar:
    "Ci penso io. Prima controllo cosa c'è nel workspace e a chi devo mandarlo.\n\n" +
    "<｜DSML｜tool_calls>\n" +
    '<｜DSML｜invoke name="list_directory">\n' +
    '<｜DSML｜parameter name="path" string="true">~/cerase/workspace</｜DSML｜parameter>\n' +
    "</｜DSML｜invoke>\n" +
    "</｜DSML｜tool_calls>",
  functionCalls:
    "Un attimo, controllo la giacenza di PN-4471 prima di confermare.\n\n" +
    "<function_calls>\n" +
    '<invoke name="giacenza">\n' +
    '<parameter name="codice">PN-4471</parameter>\n' +
    "</invoke>\n" +
    "</function_calls>",
  cutOffInsideAValue:
    "Un attimo, controllo la fattura 214/26 e ti dico.\n\n" +
    "<function_calls>\n" +
    '<invoke name="call_recipe">\n' +
    '<parameter name="recipe">cerase-memory.memory_recall</parameter>\n' +
    '<parameter name="params">{"query": "Metalli Ovest fattura 214/26 scadenza piano pagamenti", "k": 5',
  toolCallsJson:
    "Ok, ci penso io: preparo l'email per Marta e la invio.\n\n" +
    "<tool_calls>\n" +
    '[{"name": "skill", "arguments": {"name": "email-drafting"}},\n' +
    ' {"name": "skill", "arguments": {"name": "workplan"}}]\n' +
    "</tool_calls>",
  toolCallJson:
    "Ok, ci penso io. Parto.\n\n" +
    "<tool_call>\n" +
    '{"name": "skill", "arguments": {"name": "workplan"}}\n' +
    "</tool_call>",
  nestedTags:
    "Ok, un attimo e te la sintetizzo.\n\n" +
    "<tool_calls>\n" +
    "<call_recipe>\n<recipe>cerase-tasks.list_tasks</recipe>\n<params>{}</params>\n</call_recipe>\n" +
    "<skill>\n<name>workplan</name>\n</skill>\n" +
    "</tool_calls>",
  bareInvoke:
    "Prima di cancellare, faccio un controllo: guardo esattamente cosa prende il filtro `stato=scaduto` — un attimo.\n\n" +
    '<invoke name="skill">\n<parameter name="name">workplan</parameter>\n</invoke>\n' +
    '<invoke name="anteprima_selezione">\n<parameter name="filtro">stato=scaduto</parameter>\n</invoke>',
  mixedClosing:
    "Un attimo, confronto le due versioni.\n\n" +
    "<tool_calls>\n" +
    '<invoke name="call_recipe">\n' +
    '<parameter name="recipe">cerase-tasks.list_tasks</｜｜DSML｜｜ parameter>\n' +
    '<parameter name="params">{}</｜｜DSML｜｜ parameter>\n' +
    "</invoke>\n" +
    "</｜｜DSML｜｜ calls>",
};

// Answers that quote the syntax to somebody who asked about it.
const QUOTED = {
  proseAfterTheBlock:
    "Una chiamata scritta in quel formato ha questa forma:\n\n" +
    "<function_calls>\n" +
    '<invoke name="cerca_fattura">\n' +
    '<parameter name="numero">2026-0512</parameter>\n' +
    "</invoke>\n" +
    "</function_calls>\n\n" +
    "Il nome dello strumento va nell'attributo name, ogni argomento in un parameter.",
  fencedAtTheEnd:
    "Ecco l'esempio che mi hai chiesto:\n\n" +
    "```xml\n" +
    "<tool_calls>\n" +
    '<invoke name="skill">\n<parameter name="name">workplan</parameter>\n</invoke>\n' +
    "</tool_calls>\n" +
    "```",
  fenceLeftOpen:
    "Ecco l'esempio che mi hai chiesto:\n\n" +
    "```xml\n" +
    "<tool_calls>\n" +
    '<invoke name="skill">\n<parameter name="name">workplan</parameter>\n</invoke>\n' +
    "</tool_calls>",
  inlineMention: 'Nel file il tag <invoke name="x"> apre la chiamata e </invoke> la chiude.',
};

describe("the rule: an answer that ends in a tool-call block", () => {
  for (const [shape, text] of Object.entries(RECORDED)) {
    it(`catches the recorded shape: ${shape}`, () => {
      expect(endsInToolCallMarkup(text)).toBe(true);
    });
  }

  for (const [shape, text] of Object.entries(QUOTED)) {
    it(`leaves a quote alone: ${shape}`, () => {
      expect(endsInToolCallMarkup(text)).toBe(false);
    });
  }

  it("leaves alone a block the answer goes on after", () => {
    // Recorded once, at max: the model wrote the block and then its answer in
    // the same message. The answer is there to be read, so it is sent.
    const text = `${RECORDED.functionCalls}\n\nLa giacenza di PN-4471 è zero: non posso confermare l'ordine.`;
    expect(endsInToolCallMarkup(text)).toBe(false);
  });

  it("starts from the opening line, whatever sentence comes before it", () => {
    const at = toolCallMarkupStart(RECORDED.functionCalls);
    expect(RECORDED.functionCalls.slice(0, at).trim()).toBe(
      "Un attimo, controllo la giacenza di PN-4471 prima di confermare.",
    );
    expect(isToolCallMarkup(RECORDED.functionCalls.slice(at))).toBe(true);
  });

  it("does not start inside a fence that an earlier piece opened", () => {
    expect(toolCallMarkupStart("<tool_calls>\n</tool_calls>", true)).toBe(-1);
    expect(toolCallMarkupStart("<tool_calls>\n</tool_calls>", false)).toBe(0);
  });

  it("holds a last line that may still become an opening tag", () => {
    const piece = "Un attimo, controllo.\n\n<tool_ca";
    expect(toolCallMarkupHoldStart(piece)).toBe(piece.indexOf("<tool_ca"));
    expect(toolCallMarkupHoldStart("Costa meno di 5 euro.")).toBe(-1);
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

/**
 * A session that answers the n-th prompt with the n-th scripted reply, streamed
 * in pieces of `size` characters, and keeps every prompt it was sent.
 */
function scripted(replies: string[], size = 1000) {
  const prompts: string[] = [];
  const mgr = {
    async prompt(_agentId: string, _userId: string, text: string, onUpdate?: SessionUpdateHandler) {
      prompts.push(text);
      const reply = replies[prompts.length - 1] ?? "";
      for (let i = 0; i < reply.length; i += size) {
        onUpdate?.({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: reply.slice(i, i + size) },
        } as Update);
        await new Promise((r) => setImmediate(r));
      }
      return { stopReason: "end_turn" };
    },
  } as unknown as SessionManager;
  return { mgr, prompts };
}

async function turn(replies: string[], message: string, size?: number) {
  const { mgr, prompts } = scripted(replies, size);
  const sent: string[] = [];
  const d = new Dispatcher({
    config: CONFIG,
    sessionManager: mgr,
    turnMeta: new TurnMetaTracker(),
    resolveSendTarget: () => async (chunk) => {
      sent.push(chunk);
      return { ok: true };
    },
  });
  const result = await d.handleMessage("a", "u", message);
  return { result, prompts, chat: sent.join("\n") };
}

const ASK = "fammi la presentazione per il primo incontro con il cliente";
const ANSWER = "Ho preparato la presentazione: cinque slide, con i numeri del mese nella terza.";

describe("an answer written as a tool call", () => {
  it("is not sent, and the assistant is given one more try that reaches the person", async () => {
    const { result, prompts, chat } = await turn([RECORDED.dsmlOnly, ANSWER], ASK);
    expect(chat).not.toMatch(/DSML|invoke|prs_3ba88f/);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.split("\n")[0]).toBe(MARKUP_RETRY_MARKER);
    expect(chat).toContain(ANSWER);
    expect(result).toEqual({ ok: true });
  });

  it("keeps the sentence before the block and holds the block back", async () => {
    const { prompts, chat } = await turn([RECORDED.functionCalls, ANSWER], ASK);
    expect(chat).toContain("Un attimo, controllo la giacenza di PN-4471 prima di confermare.");
    expect(chat).not.toMatch(/function_calls|invoke|parameter/);
    expect(prompts).toHaveLength(2);
    expect(chat).toContain(ANSWER);
  });

  it("is held back when it streams in pieces smaller than a tag", async () => {
    const { prompts, chat } = await turn([RECORDED.dsmlAfterASentence, ANSWER], ASK, 7);
    expect(chat).not.toMatch(/DSML|｜|addGoogleSlideText/);
    expect(prompts).toHaveLength(2);
    expect(chat).toContain(ANSWER);
  });

  it("a second answer of the same kind ends the turn with a notice, and there is no third try", async () => {
    const { result, prompts, chat } = await turn([RECORDED.dsmlOnly, RECORDED.toolCallsJson], ASK);
    expect(prompts).toHaveLength(2);
    expect(chat).not.toMatch(/DSML|tool_calls|"arguments"/);
    expect(chat).toMatch(/non te l'ho mandata\. Chiedimelo di nuovo/);
    expect(result.ok).toBe(false);
  });

  it("an answer that quotes the syntax inside prose is sent unchanged, and nothing is retried", async () => {
    const { result, prompts, chat } = await turn([QUOTED.proseAfterTheBlock], "come si scrive una chiamata in xml?");
    expect(prompts).toHaveLength(1);
    expect(chat.replace(/\s+/g, " ")).toBe(QUOTED.proseAfterTheBlock.replace(/\s+/g, " "));
    expect(result).toEqual({ ok: true });
  });

  it("an answer that quotes the syntax in a code fence is sent unchanged", async () => {
    const { prompts, chat } = await turn([QUOTED.fencedAtTheEnd], "mi fai un esempio di chiamata in xml?", 9);
    expect(prompts).toHaveLength(1);
    expect(chat.replace(/\s+/g, " ")).toBe(QUOTED.fencedAtTheEnd.replace(/\s+/g, " "));
  });
});

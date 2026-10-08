// The status line of a turn, driven through the real dispatcher: the session
// manager is replaced by one whose turns report tool calls and end when the
// test says, the channel by a recorder of the one message it keeps, and the
// catalogue by a function the test answers. The clock stands still until a
// test moves it, which is how a tool that runs four seconds is expressed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freezeBridgeClock } from "./__tests__/fake-clock.js";
import type { DeliveryResult, StatusLine } from "./chat-adapter.js";
import type { BridgeConfig } from "./config.js";
import { Dispatcher, type DispatcherDeps } from "./dispatcher.js";
import type { PromptOptions, SessionManager, SessionUpdateHandler } from "./session-manager.js";
import { messageStatusLine } from "./status-line.js";
import type { ToolStep } from "./tool-step.js";
import { TurnMetaTracker } from "./turn-meta.js";

type Update = Parameters<SessionUpdateHandler>[0];

const IT = "mi riassumi il foglio del budget?";
const EN = "can you summarise the budget sheet for me?";

interface HeldPrompt {
  text: string;
  update(u: Record<string, unknown>): void;
  say(text: string): void;
  /** What the session manager tells a prompt when its session starts or stops summarising. */
  compacting(on: boolean): void;
  end(reply?: string): void;
}

/** The one message a channel keeps for the status, as the platform would see it. */
interface Channel {
  posts: { id: number; text: string }[];
  edits: { id: number; text: string }[];
  removed: number[];
  /** Every post asked of the platform, refused ones included. */
  attempts: string[];
  line: StatusLine;
}

function channel(fail: { post?: boolean; edit?: boolean; remove?: boolean } = {}): Channel {
  const c: Channel = {
    posts: [],
    edits: [],
    removed: [],
    attempts: [],
    line: undefined as unknown as StatusLine,
  };
  c.line = messageStatusLine<number>(
    {
      post: async (text) => {
        c.attempts.push(text);
        if (fail.post) throw new Error("the platform refused the post");
        const id = c.posts.length + 1;
        c.posts.push({ id, text });
        return id;
      },
      edit: async (id, text) => {
        if (fail.edit) throw new Error("the platform refused the edit");
        c.edits.push({ id, text });
      },
      remove: async (id) => {
        if (fail.remove) throw new Error("the platform refused the delete");
        c.removed.push(id);
      },
    },
    { test: true },
  );
  return c;
}

const toolCall = (id: string, title: string, rawInput: Record<string, unknown> = {}) => ({
  sessionUpdate: "tool_call",
  toolCallId: id,
  title,
  kind: "other",
  status: "pending",
  rawInput,
});
const running = (id: string, rawInput: Record<string, unknown>) => ({
  sessionUpdate: "tool_call_update",
  toolCallId: id,
  status: "in_progress",
  rawInput,
});
const done = (id: string, title = "a title of the runtime's own") => ({
  sessionUpdate: "tool_call_update",
  toolCallId: id,
  status: "completed",
  title,
});

const SHEET = { recipe_name: "google-workspace.getGoogleSheetContent", args: { spreadsheetId: "abc", range: "A1:Z9" } };
const SENTENCES: Record<string, string> = {
  "google-workspace.getGoogleSheetContent": "Sto leggendo un foglio Google…",
  "google-workspace.readGoogleDoc": "Sto leggendo un documento Google…",
  "cerase-gateway_call_recipe": "Sto usando uno dei tuoi collegamenti…",
  webfetch: "Sto aprendo una pagina web…",
  edit: "Sto modificando un file…",
};

describe("the status line of a turn", () => {
  let prompts: HeldPrompt[];
  let sent: string[];
  let asked: ToolStep[];
  let catalogue: (step: ToolStep) => Promise<string>;

  const config: BridgeConfig = {
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

  const sessionManager = {
    prompt: (
      _agentId: string,
      _userId: string,
      text: string,
      onUpdate?: (u: Update) => void,
      options?: PromptOptions,
    ) =>
      new Promise((resolve) => {
        const update = (u: Record<string, unknown>) => onUpdate?.(u as unknown as Update);
        const say = (t: string) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
        prompts.push({
          text,
          update,
          say,
          compacting: (on) => options?.onCompaction?.(on),
          end: (reply) => {
            if (reply) say(reply);
            resolve({ stopReason: "end_turn" });
          },
        });
      }),
    holdTurn: () => () => {},
  } as unknown as SessionManager;

  function dispatcher(line: StatusLine | undefined, extra: Partial<DispatcherDeps> = {}): Dispatcher {
    return new Dispatcher({
      config,
      sessionManager,
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget:
        () =>
        async (chunk: string): Promise<DeliveryResult> => {
          sent.push(chunk);
          return { ok: true };
        },
      resolveStatusLine: () => line,
      toolStep: (_agentId, step) => {
        asked.push(step);
        return catalogue(step);
      },
      ...extra,
    });
  }

  /** Let the promises the timers released run, without moving the clock. */
  const settle = () => vi.advanceTimersByTimeAsync(0);
  const elapse = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const promptCount = (n: number) => vi.waitFor(() => expect(prompts).toHaveLength(n));

  beforeEach(() => {
    freezeBridgeClock();
    prompts = [];
    sent = [];
    asked = [];
    catalogue = async (step) => {
      const recipe = (step.input as { recipe_name?: string }).recipe_name;
      const sentence = SENTENCES[recipe ?? step.tool];
      if (!sentence) throw new Error(`no sentence for ${step.tool}`);
      return sentence;
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is posted once a tool has run four seconds, with the catalogue's sentence for that step", async () => {
    const c = channel();
    const turn = dispatcher(c.line).handleMessage("agent-1", "111", IT);
    await promptCount(1);
    prompts[0]!.update(toolCall("c1", "cerase-gateway_call_recipe"));
    prompts[0]!.update(running("c1", SHEET));
    await elapse(3_999);
    expect(c.posts).toEqual([]);
    expect(asked).toEqual([]);

    await elapse(1);
    expect(c.posts).toEqual([{ id: 1, text: "Sto leggendo un foglio Google…" }]);
    // The name the tool started with and the input it was given, in the
    // conversation's language.
    expect(asked).toEqual([{ tool: "cerase-gateway_call_recipe", input: SHEET, lang: "it" }]);

    prompts[0]!.update(done("c1"));
    prompts[0]!.end("Ecco il riepilogo del foglio.");
    expect(await turn).toEqual({ ok: true });
    await settle();
    expect(c.posts).toHaveLength(1);
    expect(sent).toEqual(["Ecco il riepilogo del foglio."]);
  });

  it("is edited in place by each tool started after it, and deleted when the turn ends", async () => {
    const c = channel();
    const turn = dispatcher(c.line).handleMessage("agent-1", "111", IT);
    await promptCount(1);
    prompts[0]!.update(toolCall("c1", "webfetch", { url: "https://example.com" }));
    await elapse(4_000);
    expect(c.posts).toEqual([{ id: 1, text: "Sto aprendo una pagina web…" }]);
    prompts[0]!.update(done("c1"));

    // The next tool starts with no input yet, and its sentence depends on the
    // recipe: the line says the step at once, and again once the input is
    // known, no sooner than 1.5 seconds after.
    await elapse(2_000);
    prompts[0]!.update(toolCall("c2", "cerase-gateway_call_recipe"));
    await settle();
    expect(asked.at(-1)).toEqual({ tool: "cerase-gateway_call_recipe", input: {}, lang: "it" });
    expect(c.edits).toEqual([{ id: 1, text: "Sto usando uno dei tuoi collegamenti…" }]);
    prompts[0]!.update(running("c2", { recipe_name: "google-workspace.readGoogleDoc", args: { documentId: "d" } }));
    await elapse(1_499);
    expect(c.edits).toHaveLength(1);
    await elapse(1);
    expect(c.edits.at(-1)).toEqual({ id: 1, text: "Sto leggendo un documento Google…" });
    prompts[0]!.update(done("c2"));

    await elapse(2_000);
    prompts[0]!.update(toolCall("c3", "edit", { filePath: "/home/agent/cerase/workspace/bozza.md" }));
    await settle();
    expect(c.edits).toEqual([
      { id: 1, text: "Sto usando uno dei tuoi collegamenti…" },
      { id: 1, text: "Sto leggendo un documento Google…" },
      { id: 1, text: "Sto modificando un file…" },
    ]);
    expect(c.removed).toEqual([]);

    prompts[0]!.update(done("c3"));
    prompts[0]!.end("Fatto: ho aggiornato la bozza.");
    expect(await turn).toEqual({ ok: true });
    await settle();
    expect(c.posts).toHaveLength(1);
    expect(c.removed).toEqual([1]);
  });

  it("is edited at most once every 1.5 seconds, and shows the latest step when steps come faster", async () => {
    const c = channel();
    const turn = dispatcher(c.line).handleMessage("agent-1", "111", IT);
    await promptCount(1);
    prompts[0]!.update(toolCall("c1", "webfetch", { url: "https://example.com" }));
    await elapse(4_000);
    expect(c.posts).toHaveLength(1);

    prompts[0]!.update(done("c1"));
    prompts[0]!.update(toolCall("c2", "edit", { filePath: "a.md" }));
    prompts[0]!.update(done("c2"));
    prompts[0]!.update(toolCall("c3", "cerase-gateway_call_recipe", SHEET));
    prompts[0]!.update(done("c3"));
    prompts[0]!.update(toolCall("c4", "cerase-gateway_call_recipe", { recipe_name: "google-workspace.readGoogleDoc" }));
    await elapse(1_499);
    expect(c.edits).toEqual([]);
    await elapse(1);
    expect(c.edits).toEqual([{ id: 1, text: "Sto leggendo un documento Google…" }]);

    prompts[0]!.update(done("c4"));
    prompts[0]!.end("Ecco.");
    await turn;
    await settle();
    expect(c.edits).toHaveLength(1);
    expect(c.removed).toEqual([1]);
  });

  it("is never posted for a turn whose tools all finish within four seconds", async () => {
    const c = channel();
    const turn = dispatcher(c.line).handleMessage("agent-1", "111", IT);
    await promptCount(1);
    for (const id of ["c1", "c2", "c3"]) {
      prompts[0]!.update(toolCall(id, "webfetch", { url: "https://example.com" }));
      await elapse(3_900);
      prompts[0]!.update(done(id));
    }
    await elapse(10_000);
    prompts[0]!.end("Ecco quello che ho trovato.");
    expect(await turn).toEqual({ ok: true });
    await settle();
    expect(c.attempts).toEqual([]);
    expect(c.removed).toEqual([]);
    expect(asked).toEqual([]);
    expect(sent).toEqual(["Ecco quello che ho trovato."]);

    // The next turn's tools are as quick, but for its last, which is the only
    // step the status ever names.
    const next = channel();
    const second = dispatcher(next.line).handleMessage("agent-1", "111", IT);
    await promptCount(2);
    prompts[1]!.update(toolCall("c1", "webfetch", { url: "https://example.com" }));
    await elapse(3_900);
    prompts[1]!.update(done("c1"));
    prompts[1]!.update(toolCall("c2", "edit", { filePath: "a.md" }));
    await elapse(4_000);
    expect(next.attempts).toEqual(["Sto modificando un file…"]);
    expect(asked.map((s) => s.tool)).toEqual(["edit"]);
    prompts[1]!.update(done("c2"));
    prompts[1]!.end("Ecco.");
    await second;
  });

  it("carries no word the assistant writes, and the assistant's text neither puts it up nor takes it down", async () => {
    const c = channel();
    const turn = dispatcher(c.line).handleMessage("agent-1", "111", IT);
    await promptCount(1);
    const before = "Apro il foglio del budget e lo leggo tutto.";
    const between = "Ho letto le prime righe, continuo con il resto del foglio.";
    prompts[0]!.update({
      sessionUpdate: "agent_message_chunk",
      messageId: "m1",
      content: { type: "text", text: before },
    });
    await elapse(10_000);
    expect(c.posts).toEqual([]);

    prompts[0]!.update(toolCall("c1", "cerase-gateway_call_recipe", SHEET));
    await elapse(4_000);
    expect(c.posts).toEqual([{ id: 1, text: "Sto leggendo un foglio Google…" }]);
    prompts[0]!.update(done("c1"));
    prompts[0]!.update({
      sessionUpdate: "agent_message_chunk",
      messageId: "m2",
      content: { type: "text", text: between },
    });
    await elapse(10_000);
    expect(c.removed).toEqual([]);
    expect(c.posts).toHaveLength(1);

    prompts[0]!.end("Il budget chiude in pari.");
    await turn;
    await settle();
    expect(c.removed).toEqual([1]);
    const status = [...c.posts, ...c.edits].map((m) => m.text).join("\n");
    for (const words of [before, between, "Il budget chiude in pari."]) {
      expect(status).not.toContain(words);
      expect(sent.join("")).toContain(words);
    }
  });

  it("says the bridge's plain sentence, in the conversation's language, when the catalogue cannot answer", async () => {
    catalogue = async () => {
      throw new Error("tool-step: HTTP 500");
    };
    const it1 = channel();
    const d1 = dispatcher(it1.line);
    const turnIt = d1.handleMessage("agent-1", "111", IT);
    await promptCount(1);
    prompts[0]!.update(toolCall("c1", "webfetch", { url: "https://example.com" }));
    await elapse(4_000);
    expect(it1.posts).toEqual([{ id: 1, text: "Sto lavorando…" }]);
    prompts[0]!.end("Ecco.");
    expect(await turnIt).toEqual({ ok: true });

    const en = channel();
    const turnEn = dispatcher(en.line, { toolStep: undefined }).handleMessage("agent-1", "111", EN);
    await promptCount(2);
    prompts[1]!.update(toolCall("c1", "webfetch", { url: "https://example.com" }));
    await elapse(4_000);
    expect(en.posts).toEqual([{ id: 1, text: "Working on it…" }]);
    prompts[1]!.end("Here it is.");
    expect(await turnEn).toEqual({ ok: true });
  });

  it("is asked of the channel at every turn, and a channel that keeps none gets nothing but the answer", async () => {
    const askedOf: string[][] = [];
    const turn = dispatcher(undefined, {
      resolveStatusLine: (agentId, userId) => {
        askedOf.push([agentId, userId]);
        return undefined;
      },
    }).handleMessage("agent-1", "111", IT);
    await promptCount(1);
    expect(askedOf).toEqual([["agent-1", "111"]]);
    prompts[0]!.update(toolCall("c1", "cerase-gateway_call_recipe", SHEET));
    await elapse(4_000);
    prompts[0]!.update(done("c1"));
    prompts[0]!.update(toolCall("c2", "edit", { filePath: "a.md" }));
    await elapse(4_000);
    prompts[0]!.update(done("c2"));
    prompts[0]!.end("Ecco il riepilogo.");
    expect(await turn).toEqual({ ok: true });
    expect(sent).toEqual(["Ecco il riepilogo."]);
    expect(asked).toEqual([]);
  });

  it("costs the turn nothing when the channel refuses it, or cannot make one", async () => {
    const refused = channel({ post: true, edit: true, remove: true });
    const turn = dispatcher(refused.line).handleMessage("agent-1", "111", IT);
    await promptCount(1);
    prompts[0]!.update(toolCall("c1", "webfetch", { url: "https://example.com" }));
    await elapse(4_000);
    prompts[0]!.update(done("c1"));
    prompts[0]!.update(toolCall("c2", "edit", { filePath: "a.md" }));
    await elapse(4_000);
    prompts[0]!.end("Ecco il riepilogo.");
    expect(await turn).toEqual({ ok: true });
    expect(sent).toEqual(["Ecco il riepilogo."]);
    // Refused once, it is not posted again: two messages could be left behind.
    expect(refused.attempts).toEqual(["Sto aprendo una pagina web…"]);

    const broken = dispatcher(undefined, {
      resolveStatusLine: () => {
        throw new Error("the adapter could not make a status line");
      },
    }).handleMessage("agent-1", "111", IT);
    await promptCount(2);
    prompts[1]!.update(toolCall("c1", "webfetch", { url: "https://example.com" }));
    await elapse(4_000);
    prompts[1]!.end("Ecco di nuovo.");
    expect(await broken).toEqual({ ok: true });
    expect(sent).toEqual(["Ecco il riepilogo.", "Ecco di nuovo."]);
  });

  // While opencode summarises a long conversation it sends nothing for minutes,
  // and the person would otherwise read a chat that has gone quiet. The words
  // are the operator's.
  it("says the assistant is taking stock while the session summarises, in the conversation's language", async () => {
    const c = channel();
    const turn = dispatcher(c.line).handleMessage("agent-1", "111", IT);
    await promptCount(1);
    prompts[0]!.compacting(true);
    await settle();
    expect(c.posts).toEqual([
      { id: 1, text: "Sto facendo il punto su quello che ci siamo detti finora: un paio di minuti e riprendo." },
    ]);
    // Once the summary is written the line says the assistant is at work
    // again, and the end of the turn takes it down.
    prompts[0]!.compacting(false);
    await elapse(1_500);
    expect(c.edits).toEqual([{ id: 1, text: "Sto lavorando…" }]);
    prompts[0]!.end("Ecco il riepilogo.");
    expect(await turn).toEqual({ ok: true });
    await settle();
    expect(c.removed).toEqual([1]);
    expect(sent).toEqual(["Ecco il riepilogo."]);

    const en = channel();
    const turnEn = dispatcher(en.line).handleMessage("agent-1", "111", EN);
    await promptCount(2);
    prompts[1]!.compacting(true);
    await settle();
    expect(en.posts).toEqual([
      {
        id: 1,
        text: "I'm taking stock of what we've said so far: give me a couple of minutes and I'll pick up again.",
      },
    ]);
    prompts[1]!.end("Here it is.");
    expect(await turnEn).toEqual({ ok: true });
  });

  it("gives the line back to the step that follows the summary", async () => {
    const c = channel();
    const turn = dispatcher(c.line).handleMessage("agent-1", "111", IT);
    await promptCount(1);
    prompts[0]!.compacting(true);
    await settle();
    expect(c.posts).toHaveLength(1);
    prompts[0]!.compacting(false);
    prompts[0]!.update(toolCall("c1", "cerase-gateway_call_recipe", SHEET));
    await elapse(1_500);
    expect(c.edits.at(-1)).toEqual({ id: 1, text: "Sto leggendo un foglio Google…" });
    prompts[0]!.update(done("c1"));
    prompts[0]!.end("Ecco.");
    expect(await turn).toEqual({ ok: true });
  });

  it("stays up through a follow-up of the same turn, and is deleted after the last one", async () => {
    const c = channel();
    const turn = dispatcher(c.line).handleMessage("agent-1", "111", IT);
    await promptCount(1);
    prompts[0]!.update(toolCall("c1", "cerase-gateway_call_recipe", SHEET));
    await elapse(4_000);
    expect(c.posts).toHaveLength(1);
    prompts[0]!.update(done("c1"));
    // The answer came out as a tool call written as text: held back, and the
    // assistant is asked once more on the same turn.
    prompts[0]!.end(
      '<tool_calls>\n<invoke name="read">\n<parameter name="path">a.md</parameter>\n</invoke>\n</tool_calls>',
    );
    await promptCount(2);
    await elapse(10_000);
    expect(c.removed).toEqual([]);

    prompts[1]!.update(toolCall("c2", "edit", { filePath: "a.md" }));
    await elapse(1_500);
    expect(c.edits).toEqual([{ id: 1, text: "Sto modificando un file…" }]);
    prompts[1]!.update(done("c2"));
    prompts[1]!.end("Il budget chiude in pari.");
    expect(await turn).toEqual({ ok: true });
    await settle();
    expect(c.removed).toEqual([1]);
  });
});

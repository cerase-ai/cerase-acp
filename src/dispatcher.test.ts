import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AttachOutcomeTracker } from "./attach-outcome.js";
import type { BridgeConfig } from "./config.js";
import {
  Dispatcher,
  isCreditExhaustedError,
  pickEmptyMessage,
  pickErrorMessage,
  pickNoCreditsMessage,
} from "./dispatcher.js";
import { isInternalSummaryBlock } from "./egress-redaction.js";
import { SessionManager, type SessionUpdateHandler } from "./session-manager.js";
import { StreamBuffer } from "./stream-buffer.js";
import { TurnMetaTracker } from "./turn-meta.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

function makeConfig(reply: string): BridgeConfig {
  return {
    agents: [
      {
        id: "doc-qa",
        channel: "discord",
        cwd: "/home/agent/cerase/workspace",
        mode: "cerase",
        bot_token: "irrelevant",
        allowed_users: ["111"],
        spawn: { command: "env", args: ["--", `FAKE_REPLY=${reply}`, "node", FAKE_CHILD] },
      },
    ],
    session: { idle_timeout_minutes: 60, max_concurrent: 16 },
  };
}

describe("Dispatcher", () => {
  let mgr: SessionManager | undefined;

  afterEach(async () => {
    if (mgr) await mgr.shutdown();
    mgr = undefined;
  });

  it("routes an authorised user's message through the session and sends the reply", async () => {
    const cfg = makeConfig("ciao da fake-acp, tutto bene?");
    mgr = new SessionManager(cfg);
    const sent: { agentId: string; userId: string; text: string }[] = [];
    const d = new Dispatcher({
      config: cfg,
      sessionManager: mgr,
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: (agentId, userId) => async (text) => {
        sent.push({ agentId, userId, text });
        return { ok: true };
      },
    });
    await expect(d.handleMessage("doc-qa", "111", "ping")).resolves.toEqual({ ok: true });
    // M-ACP-DISCLOSURE-OFF: no AI disclosure is prepended — the reply is all
    // that's sent. Join + trim the streaming marker to reconstruct it.
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const joined = sent.map((s) => s.text.replace(/ ⏎$/u, "")).join("");
    expect(joined).toBe("ciao da fake-acp, tutto bene?");
  });

  it("refuses an unauthorised user politely and does NOT spawn a session", async () => {
    const cfg = makeConfig("never seen");
    mgr = new SessionManager(cfg);
    const sent: string[] = [];
    const d = new Dispatcher({
      config: cfg,
      sessionManager: mgr,
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: () => async (text) => {
        sent.push(text);
        return { ok: true };
      },
    });
    await d.handleMessage("doc-qa", "999-not-allowed", "hi");
    expect(mgr.activeSessionCount()).toBe(0);
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatch(/not authorised|non sono autorizzato/i);
  });

  it("prepends the [turn_meta:] block before forwarding to the agent", async () => {
    // We can't read what the fake child received; instead verify the
    // TurnMetaTracker updated. After one handleMessage call the
    // tracker should report a measured gap (not "first") on the next
    // prefix() call.
    const cfg = makeConfig("ok");
    mgr = new SessionManager(cfg);
    const tracker = new TurnMetaTracker();
    const d = new Dispatcher({
      config: cfg,
      sessionManager: mgr,
      turnMeta: tracker,
      resolveSendTarget: () => async () => ({ ok: true }),
    });
    await d.handleMessage("doc-qa", "111", "ciao");
    const next = tracker.prefix("doc-qa", "111", "again");
    expect(next).not.toContain("gap=first");
  });

  it("reuses the session across two consecutive messages from the same user", async () => {
    const cfg = makeConfig("x");
    mgr = new SessionManager(cfg);
    const d = new Dispatcher({
      config: cfg,
      sessionManager: mgr,
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: () => async () => ({ ok: true }),
    });
    await d.handleMessage("doc-qa", "111", "first");
    await d.handleMessage("doc-qa", "111", "second");
    expect(mgr.activeSessionCount()).toBe(1);
  });

  it("throws for an unknown agent id (programmer error from the adapter)", async () => {
    const cfg = makeConfig("x");
    mgr = new SessionManager(cfg);
    const d = new Dispatcher({
      config: cfg,
      sessionManager: mgr,
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: () => async () => ({ ok: true }),
    });
    await expect(d.handleMessage("ghost", "111", "hi")).rejects.toThrow(/ghost/);
  });

  // An authorised turn that fails must surface a user-facing message
  // instead of silent 👀 + typing then nothing. Centralised in the
  // dispatcher so every ingress (Discord/Slack/Telegram/web/CLI/
  // scheduled) gets it for free.
  function makeStubMgr(prompt: SessionManager["prompt"]): SessionManager {
    return { prompt } as unknown as SessionManager;
  }

  it("M-ACP-1: a failed agent turn sends a localized error and does NOT rethrow", async () => {
    const cfg = makeConfig("x");
    const sent: string[] = [];
    const d = new Dispatcher({
      config: cfg,
      sessionManager: makeStubMgr(async () => {
        throw new Error("opencode child crashed");
      }),
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: () => async (text) => {
        sent.push(text);
        return { ok: true };
      },
    });
    // Italian input → Italian error copy, and the promise resolves (no throw):
    // a failed turn resolves `{ ok: false }` while still delivering the
    // localized error copy.
    await expect(d.handleMessage("doc-qa", "111", "ciao, come va?")).resolves.toEqual({
      ok: false,
      error: expect.any(Error),
    });
    expect(sent.length).toBe(1);
    expect(sent[0]).toBe(pickErrorMessage("ciao, come va?"));
    expect(sent[0]).toMatch(/riprova|errore/i);
  });

  it("M-ACP-1: a turn that produced zero text chunks sends an empty-reply fallback", async () => {
    const cfg = makeConfig("x");
    const sent: string[] = [];
    const d = new Dispatcher({
      config: cfg,
      // resolve without ever emitting an agent_message_chunk
      sessionManager: makeStubMgr(async () => ({ stopReason: "end_turn" })),
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: () => async (text) => {
        sent.push(text);
        return { ok: true };
      },
    });
    await d.handleMessage("doc-qa", "111", "ping");
    expect(sent.length).toBe(1);
    expect(sent[0]).toBe(pickEmptyMessage("ping"));
  });

  it("M-ACP-1: a normal turn sends neither error nor empty fallback", async () => {
    const cfg = makeConfig("x");
    const sent: string[] = [];
    const d = new Dispatcher({
      config: cfg,
      sessionManager: makeStubMgr(async (_a, _u, _t, onUpdate) => {
        onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } });
        return { stopReason: "end_turn" };
      }),
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: () => async (text) => {
        sent.push(text);
        return { ok: true };
      },
    });
    await d.handleMessage("doc-qa", "111", "ping");
    const joined = sent.join("");
    expect(joined).not.toBe(pickErrorMessage("ping"));
    expect(joined).not.toBe(pickEmptyMessage("ping"));
    expect(joined).toContain("hi");
  });
});

// M-ACP-DISCLOSURE-OFF — the AI-Act first-contact disclosure was removed: the
// assistant is USER-facing (the employee was given it and knows it's an AI), so
// Art. 50's "obvious from the context of use" exemption applies. Guard that no
// AI-disclaimer copy is prepended to the first reply.
describe("no AI disclaimer on first contact (M-ACP-DISCLOSURE-OFF)", () => {
  function makeStubMgr(prompt: SessionManager["prompt"]): SessionManager {
    return { prompt } as unknown as SessionManager;
  }
  const okTurn: SessionManager["prompt"] = async (_a, _u, _t, onUpdate) => {
    onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
    return { stopReason: "end_turn" };
  };

  it("sends only the reply on first contact — never a disclaimer", async () => {
    const cfg = makeConfig("x");
    const sent: string[] = [];
    const d = new Dispatcher({
      config: cfg,
      sessionManager: makeStubMgr(okTurn),
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: () => async (text) => {
        sent.push(text);
        return { ok: true };
      },
    });
    await d.handleMessage("doc-qa", "111", "ciao, mi puoi aiutare?");
    expect(sent.join("")).toBe("ok");
    expect(sent.join("")).not.toMatch(/assistente AI|AI assistant|sistema automatizzato|automated system/i);
  });
});

describe("402 overquota copy (M-ACP-2)", () => {
  function makeStubMgr(prompt: SessionManager["prompt"]): SessionManager {
    return { prompt } as unknown as SessionManager;
  }

  it("isCreditExhaustedError recognises the credit-gate signatures", () => {
    expect(isCreditExhaustedError(new Error('429 {"error":"cerase credit gate: tenant credits exhausted"}'))).toBe(
      true,
    );
    expect(isCreditExhaustedError(new Error("BudgetExceededError: over budget"))).toBe(true);
    expect(isCreditExhaustedError(new Error("ECONNRESET"))).toBe(false);
  });

  it("a credit-exhausted turn sends the dedicated copy instead of the generic error", async () => {
    const cfg = makeConfig("x");
    const sent: string[] = [];
    const d = new Dispatcher({
      config: cfg,
      sessionManager: makeStubMgr(async () => {
        throw new Error("agent turn failed: cerase credit gate: tenant credits exhausted (402)");
      }),
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: () => async (text) => {
        sent.push(text);
        return { ok: true };
      },
    });
    await d.handleMessage("doc-qa", "111", "ciao, mi aiuti con una cosa?");
    // M-ACP-DISCLOSURE-OFF: no disclosure — sent[0] is the failure copy.
    expect(sent[0]).toBe(pickNoCreditsMessage("ciao, mi aiuti con una cosa?"));
    expect(sent[0]).toMatch(/credit/i);
    expect(sent[0]).not.toBe(pickErrorMessage("ciao, mi aiuti con una cosa?"));
  });
});

// The reactive credit copy above is dead in production: opencode swallows
// the LiteLLM 429/402, so `prompt()` never throws the credit text — it hangs
// until the 10-min watchdog. The bridge instead checks credits proactively
// (before spawning/prompting) via the injected `creditCheck` dep; on
// exhaustion it replies the no-credits copy and never starts a turn.
// Fail-open: a missing dep or a failing check must never block chat.
describe("proactive credit gate (M-MUTE-SURFACE-2)", () => {
  function makeStubMgr(prompt: SessionManager["prompt"]): SessionManager {
    return { prompt } as unknown as SessionManager;
  }
  const okTurn: SessionManager["prompt"] = async (_a, _u, _t, onUpdate) => {
    onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
    return { stopReason: "end_turn" };
  };

  it("out of credits: replies the no-credits copy and NEVER spawns/prompts", async () => {
    const cfg = makeConfig("x");
    const sent: string[] = [];
    let promptCalled = false;
    const d = new Dispatcher({
      config: cfg,
      // A prompt stub that FAILS the test if the gate lets it run.
      sessionManager: makeStubMgr(async () => {
        promptCalled = true;
        throw new Error("prompt must not be called when credits are exhausted");
      }),
      turnMeta: new TurnMetaTracker(),
      creditCheck: async () => ({ exhausted: true }),
      resolveSendTarget: () => async (text) => {
        sent.push(text);
        return { ok: true };
      },
    });
    await d.handleMessage("doc-qa", "111", "ciao, mi aiuti con una cosa?");
    expect(promptCalled).toBe(false);
    expect(sent.length).toBe(1);
    expect(sent[0]).toBe(pickNoCreditsMessage("ciao, mi aiuti con una cosa?"));
    expect(sent[0]).toMatch(/credit/i);
  });

  it("has credits: proceeds through the normal turn (prompt IS called)", async () => {
    const cfg = makeConfig("x");
    const sent: string[] = [];
    let promptCalled = false;
    const d = new Dispatcher({
      config: cfg,
      sessionManager: makeStubMgr(async (a, u, t, onUpdate) => {
        promptCalled = true;
        return okTurn(a, u, t, onUpdate);
      }),
      turnMeta: new TurnMetaTracker(),
      creditCheck: async () => ({ exhausted: false }),
      resolveSendTarget: () => async (text) => {
        sent.push(text);
        return { ok: true };
      },
    });
    await d.handleMessage("doc-qa", "111", "ping");
    expect(promptCalled).toBe(true);
    expect(sent.join("")).toContain("ok");
    expect(sent.join("")).not.toBe(pickNoCreditsMessage("ping"));
  });

  it("credit-check throws: fails OPEN — proceeds through the normal turn", async () => {
    const cfg = makeConfig("x");
    const sent: string[] = [];
    let promptCalled = false;
    const d = new Dispatcher({
      config: cfg,
      sessionManager: makeStubMgr(async (a, u, t, onUpdate) => {
        promptCalled = true;
        return okTurn(a, u, t, onUpdate);
      }),
      turnMeta: new TurnMetaTracker(),
      creditCheck: async () => {
        throw new Error("control-plane unreachable");
      },
      resolveSendTarget: () => async (text) => {
        sent.push(text);
        return { ok: true };
      },
    });
    await d.handleMessage("doc-qa", "111", "ping");
    expect(promptCalled).toBe(true);
    expect(sent.join("")).toContain("ok");
  });

  it("no creditCheck dep (back-compat): proceeds through the normal turn", async () => {
    const cfg = makeConfig("x");
    const sent: string[] = [];
    let promptCalled = false;
    const d = new Dispatcher({
      config: cfg,
      sessionManager: makeStubMgr(async (a, u, t, onUpdate) => {
        promptCalled = true;
        return okTurn(a, u, t, onUpdate);
      }),
      turnMeta: new TurnMetaTracker(),
      // creditCheck intentionally omitted
      resolveSendTarget: () => async (text) => {
        sent.push(text);
        return { ok: true };
      },
    });
    await d.handleMessage("doc-qa", "111", "ping");
    expect(promptCalled).toBe(true);
    expect(sent.join("")).toContain("ok");
  });
});

// A file the person never received must not close as a delivered turn, and the
// assistant must hear what happened while the conversation is still about it.
// Driven against the real SessionManager and a real ACP child over stdio,
// because the send target and the model are the two halves whose disagreement
// is the whole defect -- a stubbed prompt() cannot show what the assistant was
// told.
describe("a failed attach denies the turn its success", () => {
  let mgr: SessionManager | undefined;

  afterEach(async () => {
    if (mgr) await mgr.shutdown();
    mgr = undefined;
  });

  // The child answers with the prompt it received, so the chat transcript
  // contains, verbatim, what the bridge told the assistant.
  function echoConfig(): BridgeConfig {
    return {
      agents: [
        {
          id: "doc-qa",
          channel: "discord",
          cwd: "/home/agent/cerase/workspace",
          mode: "cerase",
          bot_token: "irrelevant",
          allowed_users: ["111"],
          spawn: { command: "env", args: ["--", "FAKE_ECHO_PROMPT=1", "node", FAKE_CHILD] },
        },
      ],
      session: { idle_timeout_minutes: 60, max_concurrent: 16 },
    };
  }

  it("reports the turn as failed and tells the assistant which file did not arrive", async () => {
    const cfg = echoConfig();
    mgr = new SessionManager(cfg);
    const outcomes = new AttachOutcomeTracker();
    const sent: string[] = [];
    let recorded = false;
    const d = new Dispatcher({
      config: cfg,
      sessionManager: mgr,
      turnMeta: new TurnMetaTracker(),
      attachOutcomes: outcomes,
      // Stands in for the bridge's send path, which is where the upload is
      // attempted and where the failure is recorded.
      resolveSendTarget: (agentId, userId) => async (text) => {
        sent.push(text);
        if (!recorded) {
          recorded = true;
          outcomes.record(agentId, userId, {
            fileName: "falco-presentation.pdf",
            reason: "ambiguous workspace path",
          });
        }
        return { ok: true };
      },
    });

    const result = await d.handleMessage("doc-qa", "111", "fammi il deck sul progetto Falco");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.message).toContain("falco-presentation.pdf");

    const joined = sent.join("");
    expect(joined).toContain("[attach_result: failed]");
    expect(joined).toContain("falco-presentation.pdf: ambiguous workspace path");
    expect(joined).toMatch(/Do not claim delivery/);
  });

  it("a turn whose attachments all arrived is unaffected", async () => {
    const cfg = echoConfig();
    mgr = new SessionManager(cfg);
    const sent: string[] = [];
    const d = new Dispatcher({
      config: cfg,
      sessionManager: mgr,
      turnMeta: new TurnMetaTracker(),
      attachOutcomes: new AttachOutcomeTracker(),
      resolveSendTarget: () => async (text) => {
        sent.push(text);
        return { ok: true };
      },
    });

    await expect(d.handleMessage("doc-qa", "111", "ciao")).resolves.toEqual({ ok: true });
    expect(sent.join("")).not.toContain("[attach_result: failed]");
  });

  it("an attach the correction itself asks for does not trigger a second correction", async () => {
    const cfg = echoConfig();
    mgr = new SessionManager(cfg);
    const outcomes = new AttachOutcomeTracker();
    const sent: string[] = [];
    const d = new Dispatcher({
      config: cfg,
      sessionManager: mgr,
      turnMeta: new TurnMetaTracker(),
      attachOutcomes: outcomes,
      // Every send records a failure: the shape of an assistant that keeps
      // re-attaching a file it cannot deliver.
      resolveSendTarget: (agentId, userId) => async (text) => {
        sent.push(text);
        outcomes.record(agentId, userId, { fileName: "deck.pdf", reason: "workspace file not found" });
        return { ok: true };
      },
    });

    const result = await d.handleMessage("doc-qa", "111", "il deck");
    expect(result.ok).toBe(false);
    // Exactly one correction: the turn ends rather than looping on itself.
    expect(sent.filter((s) => s.includes("[attach_result: failed]")).length).toBe(1);
    expect(outcomes.take("doc-qa", "111")).toEqual([]);
  });
});

// A summary that streams INSIDE a turn. opencode compacts on overflow in the
// middle of a turn and the compaction agent's text arrives as ordinary message
// chunks, so it goes through the stream buffer like an answer and is flushed in
// pieces. The internal-summary filter needs three of the block's section
// headings to withhold anything, and each piece carries fewer.
describe("a summary streamed inside a turn", () => {
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
    "### Active",
    "- Stesura della tabella di confronto con prezzi, tempi e condizioni di pagamento dei tre.",
    "### Blocked",
    "- Manca il listino del terzo fornitore.",
  ].join("\n");

  const LEAD =
    "Ho confrontato le tre offerte che mi hai inoltrato. La più conveniente sul prezzo è quella del secondo " +
    "fornitore, ma i tempi di consegna sono più lunghi di due settimane rispetto alle altre due proposte.\n\n";

  type Update = Parameters<SessionUpdateHandler>[0];

  /** The reply as the agent streams it: pieces of about fifty characters. */
  function chunked(text: string, messageId?: string, size = 50): Update[] {
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

  /**
   * A session manager that streams `updates` one event-loop turn apart, then
   * runs `after` while the turn is still open, and ends it — by throwing
   * `fail` when one is given. Before `after` it waits long enough for the send
   * queue, which spaces its sends, to deliver everything already handed to it:
   * what `after` sees is what the person had read before the turn ended.
   */
  function streamingMgr(updates: Update[], after: () => void, fail?: Error): SessionManager {
    return {
      async prompt(_agentId: string, _userId: string, _text: string, onUpdate?: SessionUpdateHandler) {
        for (const u of updates) {
          onUpdate?.(u);
          await new Promise((r) => setImmediate(r));
        }
        await new Promise((r) => setTimeout(r, 400));
        after();
        if (fail) throw fail;
        return { stopReason: "end_turn" };
      },
    } as unknown as SessionManager;
  }

  /**
   * What reached the chat. The send target applies the same per-piece summary
   * filter the bridge's send path does, so what lands in `delivered` is what a
   * person would have read.
   */
  function harness(updates: Update[], fail?: Error) {
    const delivered: string[] = [];
    const withheld: string[] = [];
    let duringTurn: string[] = [];
    const d = new Dispatcher({
      config: makeConfig("unused"),
      sessionManager: streamingMgr(updates, () => (duringTurn = [...delivered]), fail),
      turnMeta: new TurnMetaTracker(),
      onSummaryWithheld: (_agentId, summary) => withheld.push(summary),
      resolveSendTarget: () => async (chunk) => {
        if (!isInternalSummaryBlock(chunk)) delivered.push(chunk);
        return { ok: true };
      },
    });
    return { d, delivered, withheld, duringTurn: () => duringTurn };
  }

  const squash = (s: string) => s.replace(/\s+/g, "");

  it("streams in pieces each of which the whole-reply filter lets through", () => {
    // The defect, stated on the unchanged buffer: the complete block is a
    // summary, and not one of the pieces it is flushed in is.
    expect(SUMMARY.length).toBe(472);
    expect(isInternalSummaryBlock(SUMMARY)).toBe(true);
    const pieces: string[] = [];
    const buffer = new StreamBuffer({ onFlush: (p) => pieces.push(p) });
    for (const u of chunked(SUMMARY)) {
      if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") buffer.push(u.content.text);
    }
    buffer.end();
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.filter((p) => isInternalSummaryBlock(p))).toEqual([]);
  });

  it("is not delivered at all, and is handed over for capture", async () => {
    const h = harness(chunked(SUMMARY));
    await expect(h.d.handleMessage("doc-qa", "111", "ciao")).resolves.toEqual({ ok: true });
    expect(h.delivered).toEqual([]);
    expect(h.withheld).toEqual([SUMMARY]);
  });

  it("does not hold back what was sent before its first heading", async () => {
    const h = harness(chunked(LEAD + SUMMARY));
    await h.d.handleMessage("doc-qa", "111", "ciao");
    // The paragraph before the summary reached the chat while the turn was
    // still running, and it is all that did.
    expect(squash(h.duringTurn().join(""))).toBe(squash(LEAD));
    expect(h.delivered).toEqual(h.duringTurn());
    expect(h.withheld).toHaveLength(1);
    expect(h.withheld[0]).toContain("## Objective");
  });

  // One of those headings is ordinary in an answer. It holds the reply back
  // from the heading on until the end of the turn, and costs nothing else:
  // judged whole, it is not a summary, and all of it is delivered.
  it("delivers a real answer that uses one of its headings, in full, at the end of the turn", async () => {
    const ANSWER = [
      "Certo, ecco come la imposterei.",
      "",
      "## Objective",
      "Chiudere il confronto tra i tre fornitori entro venerdì, così il responsabile acquisti può decidere",
      "prima della riunione di lunedì. Ti preparo una tabella con prezzo, tempi di consegna e condizioni di",
      "pagamento, e ti segnalo le voci in cui le offerte non sono confrontabili tra loro.",
      "",
      "Se mi mandi anche il listino del terzo fornitore, lo aggiungo subito.",
    ].join("\n");
    const h = harness(chunked(ANSWER));
    await expect(h.d.handleMessage("doc-qa", "111", "come imposteresti il confronto?")).resolves.toEqual({ ok: true });
    const fromHeading = ANSWER.slice(ANSWER.indexOf("## Objective"));
    // While the turn ran, only the sentence before the heading went out.
    expect(h.duringTurn()).toEqual(["Certo, ecco come la imposterei."]);
    // At its end, the rest, whole and in one piece.
    expect(h.delivered).toEqual(["Certo, ecco come la imposterei.", fromHeading]);
    expect(h.withheld).toEqual([]);
  });

  it("leaves an ordinary answer streaming as it always did", async () => {
    const ANSWER =
      "Ho letto le tre offerte. La prima ha il prezzo più alto ma consegna in una settimana, ed è l'unica che " +
      "include l'installazione. La seconda costa il dodici per cento in meno e consegna in tre settimane. " +
      "La terza è la più economica, ma chiede il pagamento anticipato dell'intero importo. " +
      "Se la scadenza di venerdì è rigida, la prima è l'unica che la rispetta con margine; altrimenti " +
      "la seconda è il compromesso migliore tra prezzo e condizioni. Vuoi che prepari la tabella?";
    const h = harness(chunked(ANSWER));
    await h.d.handleMessage("doc-qa", "111", "quale conviene?");
    // Some of it reached the chat before the turn ended: no hold.
    expect(h.duringTurn().length).toBeGreaterThan(0);
    expect(squash(h.delivered.join(""))).toBe(squash(ANSWER));
    expect(h.withheld).toEqual([]);
  });

  // After an overflow compaction opencode goes on with the same turn and
  // answers in a new assistant message. The summary is its own message, and
  // judging the answer together with it would withhold the answer too.
  it("delivers the answer that follows it in the same turn as a new message", async () => {
    const ANSWER =
      "Ecco il confronto che mi avevi chiesto: la seconda offerta è la più conveniente, la prima la più veloce.";
    const h = harness([...chunked(SUMMARY, "msg_compaction"), ...chunked(ANSWER, "msg_answer")]);
    await expect(h.d.handleMessage("doc-qa", "111", "ciao")).resolves.toEqual({ ok: true });
    expect(squash(h.delivered.join(""))).toBe(squash(ANSWER));
    expect(h.withheld).toEqual([SUMMARY]);
  });

  // A turn that fails ends the hold as well. What was held is judged by the
  // same rule: an answer is delivered ahead of the failure notice, a summary
  // is withheld, and nothing is carried into the next turn.
  it("judges held text when the turn fails, and delivers it when it is an answer", async () => {
    const ANSWER = "Ci sto lavorando.\n\n## Objective\nPreparare il confronto tra i tre fornitori entro venerdì.";
    const h = harness(chunked(ANSWER), new Error("opencode child crashed"));
    const result = await h.d.handleMessage("doc-qa", "111", "ciao");
    expect(result.ok).toBe(false);
    expect(h.delivered).toEqual([
      "Ci sto lavorando.",
      "## Objective\nPreparare il confronto tra i tre fornitori entro venerdì.",
      pickErrorMessage("ciao"),
    ]);
  });

  it("judges held text when the turn fails, and withholds it when it is a summary", async () => {
    const h = harness(chunked(SUMMARY), new Error("opencode child crashed"));
    await h.d.handleMessage("doc-qa", "111", "ciao");
    expect(h.delivered).toEqual([pickErrorMessage("ciao")]);
    expect(h.withheld).toEqual([SUMMARY]);
  });
});

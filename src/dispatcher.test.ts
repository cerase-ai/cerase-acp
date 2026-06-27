import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { BridgeConfig } from "./config.js";
import {
  Dispatcher,
  isCreditExhaustedError,
  pickEmptyMessage,
  pickErrorMessage,
  pickNoCreditsMessage,
} from "./dispatcher.js";
import { SessionManager } from "./session-manager.js";
import { TurnMetaTracker } from "./turn-meta.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

function makeConfig(reply: string): BridgeConfig {
  return {
    agents: [
      {
        id: "doc-qa",
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
    // M-ACP-FAILLOUD-1: a healthy turn + delivery resolves `{ ok: true }`.
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

  // M-ACP-1: an authorised turn that fails must surface a user-facing
  // message instead of silent 👀 + typing then nothing. Centralised in
  // the dispatcher so every ingress (Discord/Slack/Telegram/web/CLI/
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
    // Italian input → Italian error copy, and the promise resolves (no throw).
    // M-ACP-FAILLOUD-1: a failed turn now resolves `{ ok: false }` (truthful)
    // instead of `undefined`, while STILL delivering the localized error copy.
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
      sessionManager: makeStubMgr(async () => {}),
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
        onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } as never);
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
    onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } as never);
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

// M-ACP-2 — the 402/overquota chain (credit-gate BudgetExceededError →
// LLM call fails → opencode errors the turn) used to surface as the
// generic "something went wrong". The dispatcher now recognises the
// credit-gate signature and sends dedicated low-credit copy.
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

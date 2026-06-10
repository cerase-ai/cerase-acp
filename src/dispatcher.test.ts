import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { Dispatcher, pickErrorMessage, pickEmptyMessage, pickDisclosureMessage } from "./dispatcher.js";
import { SessionManager } from "./session-manager.js";
import { TurnMetaTracker } from "./turn-meta.js";
import type { BridgeConfig } from "./config.js";

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
      },
    });
    await d.handleMessage("doc-qa", "111", "ping");
    // M-LEGAL-1: first contact prepends the one-time AI disclosure.
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent[0].text).toBe(pickDisclosureMessage("ping"));
    // After joining + trimming the marker we should reconstruct the full reply.
    const joined = sent.slice(1).map((s) => s.text.replace(/ ⏎$/u, "")).join("");
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
      resolveSendTarget: () => async () => {},
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
      resolveSendTarget: () => async () => {},
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
      resolveSendTarget: () => async () => {},
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
      },
    });
    // Italian input → Italian error copy, and the promise resolves (no throw).
    await expect(d.handleMessage("doc-qa", "111", "ciao, come va?")).resolves.toBeUndefined();
    // sent[0] is the M-LEGAL-1 first-contact disclosure.
    expect(sent.length).toBe(2);
    expect(sent[1]).toBe(pickErrorMessage("ciao, come va?"));
    expect(sent[1]).toMatch(/riprova|errore/i);
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
      },
    });
    await d.handleMessage("doc-qa", "111", "ping");
    // sent[0] is the M-LEGAL-1 first-contact disclosure.
    expect(sent.length).toBe(2);
    expect(sent[1]).toBe(pickEmptyMessage("ping"));
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
      },
    });
    await d.handleMessage("doc-qa", "111", "ping");
    const joined = sent.join("");
    expect(joined).not.toBe(pickErrorMessage("ping"));
    expect(joined).not.toBe(pickEmptyMessage("ping"));
    expect(joined).toContain("hi");
  });
});

// M-LEGAL-1 — AI Act Art. 50 first-contact transparency (deadline
// 2026-08-02): the first turn of a (agent, user) pair must be preceded
// by a localized "you are talking to an AI" disclosure carrying the
// configured privacy-notice link. State is the in-memory turn-meta
// tracker: a bridge restart re-discloses (over-disclosure is fine).
describe("AI-Act first-contact disclosure (M-LEGAL-1)", () => {
  function makeStubMgr(prompt: SessionManager["prompt"]): SessionManager {
    return { prompt } as unknown as SessionManager;
  }
  const okTurn: SessionManager["prompt"] = async (_a, _u, _t, onUpdate) => {
    onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } as never);
  };

  it("sends a localized disclosure with the privacy link before the first reply", async () => {
    const cfg = { ...makeConfig("x"), privacy_notice_url: "https://example.org/privacy" };
    const sent: string[] = [];
    const d = new Dispatcher({
      config: cfg,
      sessionManager: makeStubMgr(okTurn),
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: () => async (text) => {
        sent.push(text);
      },
    });
    await d.handleMessage("doc-qa", "111", "ciao, mi puoi aiutare?");
    expect(sent[0]).toMatch(/assistente AI/i);
    expect(sent[0]).toContain("https://example.org/privacy");
    expect(sent.join("")).toContain("ok");
  });

  it("does not repeat the disclosure on subsequent turns", async () => {
    const cfg = { ...makeConfig("x"), privacy_notice_url: "https://example.org/privacy" };
    const sent: string[] = [];
    const d = new Dispatcher({
      config: cfg,
      sessionManager: makeStubMgr(okTurn),
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: () => async (text) => {
        sent.push(text);
      },
    });
    await d.handleMessage("doc-qa", "111", "ciao, mi puoi aiutare?");
    await d.handleMessage("doc-qa", "111", "e adesso?");
    const disclosures = sent.filter((t) => t.includes("https://example.org/privacy"));
    expect(disclosures.length).toBe(1);
  });

  it("omits the privacy link cleanly when not configured", async () => {
    const cfg = makeConfig("x"); // no privacy_notice_url
    const sent: string[] = [];
    const d = new Dispatcher({
      config: cfg,
      sessionManager: makeStubMgr(okTurn),
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: () => async (text) => {
        sent.push(text);
      },
    });
    await d.handleMessage("doc-qa", "111", "hello, can you help me?");
    expect(sent[0]).toMatch(/AI assistant/i);
    expect(sent[0]).not.toContain("undefined");
  });

  it("is not sent to users refused by the allowlist", async () => {
    const cfg = { ...makeConfig("x"), privacy_notice_url: "https://example.org/privacy" };
    const sent: string[] = [];
    const d = new Dispatcher({
      config: cfg,
      sessionManager: makeStubMgr(okTurn),
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: () => async (text) => {
        sent.push(text);
      },
    });
    await d.handleMessage("doc-qa", "999-not-allowed", "hi");
    expect(sent.length).toBe(1);
    expect(sent[0]).not.toContain("https://example.org/privacy");
  });
});

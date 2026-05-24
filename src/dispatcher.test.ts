import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { Dispatcher } from "./dispatcher.js";
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
    expect(sent.length).toBeGreaterThanOrEqual(1);
    // After joining + trimming the marker we should reconstruct the full reply.
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
});

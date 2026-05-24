import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { SessionManager, type TurnTelemetry } from "./session-manager.js";
import type { BridgeConfig } from "./config.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

function makeConfig(overrides?: {
  reply?: string;
  crashAfterPrompt?: boolean;
  idleTimeoutMinutes?: number;
  cwd?: string;
  lateBurstText?: string;
  lateBurstIntervalMs?: number;
}): BridgeConfig {
  const env: string[] = [];
  if (overrides?.reply !== undefined) env.push(`FAKE_REPLY=${overrides.reply}`);
  if (overrides?.crashAfterPrompt) env.push("FAKE_CRASH_AFTER_PROMPT=1");
  if (overrides?.lateBurstText !== undefined)
    env.push(`FAKE_LATE_BURST_TEXT=${overrides.lateBurstText}`);
  if (overrides?.lateBurstIntervalMs !== undefined)
    env.push(`FAKE_LATE_BURST_INTERVAL_MS=${overrides.lateBurstIntervalMs}`);
  // We pass env via a wrapper: `env VAR=... node fake-acp-child.mjs`.
  // Keeps the spawn shape (command + args) identical to production.
  const args = ["--", ...env, "node", FAKE_CHILD];
  return {
    agents: [
      {
        id: "doc-qa",
        bot_token: "irrelevant-for-acp-tests",
        allowed_users: ["111"],
        cwd: overrides?.cwd ?? "/home/agent/cerase/workspace",
        spawn: { command: "env", args },
      },
    ],
    session: {
      idle_timeout_minutes: overrides?.idleTimeoutMinutes ?? 60,
      max_concurrent: 16,
    },
  };
}

describe("SessionManager", () => {
  let mgr: SessionManager;

  afterEach(async () => {
    if (mgr) await mgr.shutdown();
  });

  it("spawns the configured command on first prompt and returns the reply", async () => {
    mgr = new SessionManager(makeConfig({ reply: "ciao da fake-acp" }));
    const chunks: string[] = [];
    const result = await mgr.prompt("doc-qa", "user-A", "ping", (update) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        chunks.push(update.content.text);
      }
    });
    expect(result.stopReason).toBe("end_turn");
    expect(chunks.join("")).toBe("ciao da fake-acp");
  });

  it("reuses the existing child on the second prompt for the same (agent, user)", async () => {
    mgr = new SessionManager(makeConfig({ reply: "x" }));
    expect(mgr.activeSessionCount()).toBe(0);
    await mgr.prompt("doc-qa", "user-A", "first");
    expect(mgr.activeSessionCount()).toBe(1);
    await mgr.prompt("doc-qa", "user-A", "second");
    expect(mgr.activeSessionCount()).toBe(1);
  });

  it("isolates sessions across different (agent, user) keys", async () => {
    mgr = new SessionManager(makeConfig({ reply: "x" }));
    await mgr.prompt("doc-qa", "user-A", "ping");
    await mgr.prompt("doc-qa", "user-B", "ping");
    expect(mgr.activeSessionCount()).toBe(2);
  });

  it("respawns transparently after the child crashes", async () => {
    // With the post-prompt drain (workaround for opencode upstream
    // #17505), prompt() resolves only after the stream has been
    // idle — which means a fake-child with FAKE_CRASH_AFTER_PROMPT=1
    // has already exited by the time prompt() returns. Both r1 and
    // r2 therefore see activeSessionCount()==0 right after they
    // resolve. The respawn invariant we still care about: r2 doesn't
    // throw, doesn't reuse a dead child, and produces an end_turn
    // response (= a fresh spawn happened internally).
    mgr = new SessionManager(makeConfig({ reply: "first", crashAfterPrompt: true }));
    const r1 = await mgr.prompt("doc-qa", "user-A", "ping");
    expect(r1.stopReason).toBe("end_turn");
    expect(mgr.activeSessionCount()).toBe(0);
    // next prompt must respawn transparently
    const r2 = await mgr.prompt("doc-qa", "user-A", "ping again");
    expect(r2.stopReason).toBe("end_turn");
    // r2 also crashes after its single prompt → already gone
    expect(mgr.activeSessionCount()).toBe(0);
  });

  it("serialises concurrent prompts to the same session (FIFO, no overlap)", async () => {
    mgr = new SessionManager(makeConfig({ reply: "x" }));
    // Two prompts fired in parallel for the same (agent, user).
    const [r1, r2] = await Promise.all([
      mgr.prompt("doc-qa", "user-A", "first"),
      mgr.prompt("doc-qa", "user-A", "second"),
    ]);
    expect(r1.stopReason).toBe("end_turn");
    expect(r2.stopReason).toBe("end_turn");
    expect(mgr.activeSessionCount()).toBe(1);
  });

  it("passes agent.cwd to the ACP child via session/new (not process.cwd())", async () => {
    // fake-acp-child.mjs echoes back the cwd it received in its sessionId
    // (`fake-session-cwd=<cwd>`). We can't observe the sessionId directly
    // from the public SessionManager API, but we CAN exfiltrate it
    // through the FAKE_REPLY: rig the child so the reply contains the
    // cwd. Simpler approach: spy via the internal map.
    mgr = new SessionManager(makeConfig({ reply: "ok", cwd: "/expected/path" }));
    await mgr.prompt("doc-qa", "user-A", "ping");
    // Reach into the private entries map for the assertion. Test-only,
    // accepted: it's the only path to the live sessionId without
    // changing the production API.
    const entry = (mgr as unknown as { entries: Map<string, { sessionId: string }> }).entries
      .get("doc-qa:user-A");
    expect(entry?.sessionId).toBe("fake-session-cwd=/expected/path");
  });

  it("throws when prompting an unknown agent id", async () => {
    mgr = new SessionManager(makeConfig());
    await expect(mgr.prompt("ghost", "user-A", "x")).rejects.toThrow(/ghost/);
  });

  it("shutdown() kills all live children and clears state", async () => {
    mgr = new SessionManager(makeConfig({ reply: "x" }));
    await mgr.prompt("doc-qa", "user-A", "ping");
    await mgr.prompt("doc-qa", "user-B", "ping");
    expect(mgr.activeSessionCount()).toBe(2);
    await mgr.shutdown();
    expect(mgr.activeSessionCount()).toBe(0);
  });

  it("captures a 3s burst of late chunks after end_turn (M15 ceiling bump)", async () => {
    // Upstream opencode race #17505: session/update notifications
    // continue streaming after the session/prompt RPC reply. Each chunk
    // in the burst refreshes `lastUpdateAt`, so only the
    // POST_PROMPT_MAX_DRAIN_MS ceiling cuts us off. With burst length
    // 3000ms and the M15 ceiling bumped 2000→8000, we capture the full
    // burst; pre-M15 we lost the last ~1000ms of content (visible reply
    // truncated mid-sentence).
    //
    // Burst: 30 chars at 100ms intervals = 3000ms total post-end_turn.
    const lateBurst = "abcdefghij" + "klmnopqrst" + "uvwxyz0123";
    mgr = new SessionManager(
      makeConfig({ reply: "head=", lateBurstText: lateBurst, lateBurstIntervalMs: 100 }),
    );
    const chunks: string[] = [];
    const result = await mgr.prompt("doc-qa", "user-A", "ping", (update) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        chunks.push(update.content.text);
      }
    });
    expect(result.stopReason).toBe("end_turn");
    expect(chunks.join("")).toBe("head=" + lateBurst);
  }, 10_000);

  it("emits per-turn telemetry via the onTelemetry hook (M15)", async () => {
    const captured: TurnTelemetry[] = [];
    mgr = new SessionManager(makeConfig({ reply: "abc" }), undefined, {
      onTelemetry: (t) => captured.push(t),
    });
    await mgr.prompt("doc-qa", "user-A", "ping");
    expect(captured.length).toBe(1);
    const t = captured[0]!;
    expect(t.agentId).toBe("doc-qa");
    expect(t.userId).toBe("user-A");
    expect(t.chunksReceived).toBeGreaterThan(0);
    expect(t.textChunks).toBeGreaterThan(0);
    expect(t.thoughtChunks).toBe(0);
    expect(["idle", "ceiling", "closed"]).toContain(t.drainExit);
    expect(t.promptToEndTurnMs).toBeGreaterThanOrEqual(0);
    expect(t.endTurnToDrainDoneMs).toBeGreaterThanOrEqual(0);
    expect(t.lastChunkAgeMs).toBeGreaterThanOrEqual(0);
  });

  it("kills the child after idle_timeout_minutes of inactivity", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mgr = new SessionManager(makeConfig({ reply: "x", idleTimeoutMinutes: 1 }));
      await mgr.prompt("doc-qa", "user-A", "ping");
      expect(mgr.activeSessionCount()).toBe(1);
      // Fast-forward past the 1-minute idle window
      await vi.advanceTimersByTimeAsync(61 * 1000);
      // Allow exit handler to fire
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 100));
      expect(mgr.activeSessionCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

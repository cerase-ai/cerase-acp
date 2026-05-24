import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { SessionManager } from "./session-manager.js";
import type { BridgeConfig } from "./config.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

function makeConfig(overrides?: {
  reply?: string;
  crashAfterPrompt?: boolean;
  idleTimeoutMinutes?: number;
}): BridgeConfig {
  const env: string[] = [];
  if (overrides?.reply !== undefined) env.push(`FAKE_REPLY=${overrides.reply}`);
  if (overrides?.crashAfterPrompt) env.push("FAKE_CRASH_AFTER_PROMPT=1");
  // We pass env via a wrapper: `env VAR=... node fake-acp-child.mjs`.
  // Keeps the spawn shape (command + args) identical to production.
  const args = ["--", ...env, "node", FAKE_CHILD];
  return {
    agents: [
      {
        id: "doc-qa",
        bot_token: "irrelevant-for-acp-tests",
        allowed_users: ["111"],
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
    mgr = new SessionManager(makeConfig({ reply: "first", crashAfterPrompt: true }));
    const r1 = await mgr.prompt("doc-qa", "user-A", "ping");
    expect(r1.stopReason).toBe("end_turn");
    // give the child time to exit and the manager to notice
    await new Promise((r) => setTimeout(r, 100));
    expect(mgr.activeSessionCount()).toBe(0);
    // next prompt must respawn transparently
    const r2 = await mgr.prompt("doc-qa", "user-A", "ping again");
    expect(r2.stopReason).toBe("end_turn");
    expect(mgr.activeSessionCount()).toBe(1);
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

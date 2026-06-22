import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "./config.js";
import type { RestEndpoint } from "./opencode-rest.js";
import type { CanonicalMessage } from "./reconciler.js";
import { SessionManager, type SpawnFn, type TurnTelemetry } from "./session-manager.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

function makeConfig(overrides?: {
  reply?: string;
  crashAfterPrompt?: boolean;
  idleTimeoutMinutes?: number;
  cwd?: string;
  lateBurstText?: string;
  lateBurstIntervalMs?: number;
  messageId?: string;
}): BridgeConfig {
  const env: string[] = [];
  if (overrides?.reply !== undefined) env.push(`FAKE_REPLY=${overrides.reply}`);
  if (overrides?.crashAfterPrompt) env.push("FAKE_CRASH_AFTER_PROMPT=1");
  if (overrides?.lateBurstText !== undefined) env.push(`FAKE_LATE_BURST_TEXT=${overrides.lateBurstText}`);
  if (overrides?.lateBurstIntervalMs !== undefined)
    env.push(`FAKE_LATE_BURST_INTERVAL_MS=${overrides.lateBurstIntervalMs}`);
  if (overrides?.messageId !== undefined) env.push(`FAKE_MESSAGE_ID=${overrides.messageId}`);
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

  // M-ACP-2: two concurrent FIRST prompts for the same (agent,user) must
  // not double-spawn the ACP child — the second would overwrite the first
  // in the map and leak one orphan process + split the conversation.
  it("M-ACP-2: concurrent first prompts spawn the child exactly once", async () => {
    let spawnCount = 0;
    const countingSpawn: SpawnFn = (command, args) => {
      spawnCount += 1;
      return spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
    };
    mgr = new SessionManager(makeConfig({ reply: "x" }), countingSpawn);
    await Promise.all([mgr.prompt("doc-qa", "user-A", "first"), mgr.prompt("doc-qa", "user-A", "also-first")]);
    expect(spawnCount).toBe(1);
    expect(mgr.activeSessionCount()).toBe(1);
  });

  // M-ACP-2 (kill-on-failed-handshake) is covered by the production catch
  // in spawnAndInit: a thrown initialize()/newSession() kills the child
  // before rethrowing. A focused test is omitted because the only ways to
  // force a handshake failure in this harness (instant-exit / missing
  // binary) write to a closed pipe and surface a library-level EPIPE
  // unhandled rejection that would dirty the suite — not worth the noise
  // for a one-line guard.

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
    const entry = (mgr as unknown as { entries: Map<string, { sessionId: string }> }).entries.get("doc-qa:user-A");
    expect(entry?.sessionId).toBe("fake-session-cwd=/expected/path");
  });

  it("throws when prompting an unknown agent id", async () => {
    mgr = new SessionManager(makeConfig());
    await expect(mgr.prompt("ghost", "user-A", "x")).rejects.toThrow(/ghost/);
  });

  // M-ACP-CRASH-1: a spawn/handshake failure must reject the turn for THAT
  // user without emitting an unhandled rejection — the discarded
  // inFlightSpawns.finally() chain used to reject unhandled and crash the
  // whole bridge (every user disconnected) on one recoverable failure.
  it("M-ACP-CRASH-1: a failed spawn rejects the turn with NO unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on("unhandledRejection", onUnhandled);
    try {
      // A child with no stdin/stdout makes spawnAndInit throw synchronously
      // (before the EPIPE-prone handshake path) — a clean way to force the
      // spawn rejection without dirtying the suite with library EPIPE noise.
      const badSpawn: SpawnFn = () =>
        ({ stdin: null, stdout: null, on() {}, once() {}, kill() {} }) as unknown as ReturnType<SpawnFn>;
      mgr = new SessionManager(makeConfig(), badSpawn);
      await expect(mgr.prompt("doc-qa", "user-A", "x")).rejects.toThrow(/stdin\/stdout/);
      // Let any stray unhandled rejection from the discarded finally-chain fire.
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toHaveLength(0);
      // inFlightSpawns was cleaned up → a retry re-spawns (and rejects again),
      // still with no unhandled rejection.
      await expect(mgr.prompt("doc-qa", "user-A", "y")).rejects.toThrow(/stdin\/stdout/);
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  // M-ACP-HARDEN-1: session.max_concurrent is a real ceiling — a new session
  // past the cap evicts the least-recently-used one instead of spawning an
  // unbounded number of docker-exec children.
  it("M-ACP-HARDEN-1: enforces max_concurrent by evicting the LRU session", async () => {
    const cfg = makeConfig({ reply: "x" });
    cfg.session.max_concurrent = 1;
    mgr = new SessionManager(cfg);
    await mgr.prompt("doc-qa", "user-A", "first");
    expect(mgr.activeSessionCount()).toBe(1);
    await mgr.prompt("doc-qa", "user-B", "second");
    // The ceiling held: user-A was evicted to make room for user-B.
    expect(mgr.activeSessionCount()).toBe(1);
    const entries = (mgr as unknown as { entries: Map<string, unknown> }).entries;
    expect(entries.has("doc-qa:user-B")).toBe(true);
    expect(entries.has("doc-qa:user-A")).toBe(false);
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
    mgr = new SessionManager(makeConfig({ reply: "head=", lateBurstText: lateBurst, lateBurstIntervalMs: 100 }));
    const chunks: string[] = [];
    const result = await mgr.prompt("doc-qa", "user-A", "ping", (update) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        chunks.push(update.content.text);
      }
    });
    expect(result.stopReason).toBe("end_turn");
    expect(chunks.join("")).toBe(`head=${lateBurst}`);
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

  it("M16: reconciles missing text from REST snapshot and surfaces it via onUpdate", async () => {
    // Simulate the upstream race: ACP only delivers "head=" but the
    // canonical assistant message (per opencode serve REST) is
    // "head=tail-from-rest". The reconciler must emit a synthetic
    // agent_message_chunk with "tail-from-rest" so the visible reply
    // is whole.
    const fakeEndpoint: RestEndpoint = {
      baseURL: "http://test",
      username: "opencode",
      password: "test",
    };
    const fakeCanonical: CanonicalMessage = {
      id: "msg_test",
      parts: [{ id: "prt_0", type: "text", text: "head=tail-from-rest" }],
    };
    let captured: TurnTelemetry | undefined;
    mgr = new SessionManager(makeConfig({ reply: "head=" }), undefined, {
      endpointResolver: () => fakeEndpoint,
      canonicalFetcher: async () => fakeCanonical,
      onTelemetry: (t) => (captured = t),
    });
    const chunks: string[] = [];
    await mgr.prompt("doc-qa", "user-A", "ping", (update) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        chunks.push(update.content.text);
      }
    });
    // Note: the fake child currently emits no messageId in its chunks,
    // so reconciliation is skipped — the test asserts the M16 path is
    // INERT until ACP exposes a messageId. This is the correct
    // behaviour: don't fetch when we can't address the message.
    // The richer assertion lives in the next test.
    expect(chunks.join("")).toBe("head=");
    expect(captured?.reconciledTextBytes).toBe(0);
  });

  it("M16: with messageId present, reconciler appends the missing tail", async () => {
    // To exercise the full reconciliation path we wire the fake child
    // to attach a messageId to its chunks (FAKE_MESSAGE_ID). The
    // canned REST fetcher returns a message that's strictly longer
    // than what the ACP stream delivered, so reconcile() returns a
    // single text delta the SessionManager replays via onUpdate.
    const fakeEndpoint: RestEndpoint = {
      baseURL: "http://test",
      username: "opencode",
      password: "test",
    };
    const fakeCanonical: CanonicalMessage = {
      id: "msg_test_42",
      parts: [{ id: "prt_0", type: "text", text: "ciao da fake-acpRECOVERED" }],
    };
    let captured: TurnTelemetry | undefined;
    mgr = new SessionManager(makeConfig({ reply: "ciao da fake-acp", messageId: "msg_test_42" }), undefined, {
      endpointResolver: () => fakeEndpoint,
      canonicalFetcher: async () => fakeCanonical,
      onTelemetry: (t) => (captured = t),
    });
    const chunks: string[] = [];
    await mgr.prompt("doc-qa", "user-A", "ping", (update) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        chunks.push(update.content.text);
      }
    });
    expect(chunks.join("")).toBe("ciao da fake-acpRECOVERED");
    expect(captured?.reconciledTextBytes).toBe("RECOVERED".length);
    expect(captured?.reconciledReasoningBytes).toBe(0);
  });

  it("M16: skips reconciliation when endpointResolver returns null", async () => {
    let fetcherCalls = 0;
    let captured: TurnTelemetry | undefined;
    mgr = new SessionManager(makeConfig({ reply: "x", messageId: "msg_test_88" }), undefined, {
      endpointResolver: () => null,
      canonicalFetcher: async () => {
        fetcherCalls += 1;
        return null;
      },
      onTelemetry: (t) => (captured = t),
    });
    await mgr.prompt("doc-qa", "user-A", "ping");
    expect(fetcherCalls).toBe(0);
    expect(captured?.reconciledTextBytes).toBe(0);
  });

  it("M16: degrades gracefully when fetcher throws", async () => {
    const fakeEndpoint: RestEndpoint = {
      baseURL: "http://test",
      username: "opencode",
      password: "test",
    };
    let captured: TurnTelemetry | undefined;
    mgr = new SessionManager(makeConfig({ reply: "partial", messageId: "msg_test_99" }), undefined, {
      endpointResolver: () => fakeEndpoint,
      canonicalFetcher: async () => {
        throw new Error("simulated REST timeout");
      },
      onTelemetry: (t) => (captured = t),
    });
    const chunks: string[] = [];
    const result = await mgr.prompt("doc-qa", "user-A", "ping", (update) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        chunks.push(update.content.text);
      }
    });
    expect(result.stopReason).toBe("end_turn");
    expect(chunks.join("")).toBe("partial");
    expect(captured?.reconciledTextBytes).toBe(0);
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

// M-ACP-2 — per-turn watchdog: a hung opencode child used to block that
// user's PromptQueue FOREVER (until the idle kill). The watchdog kills
// the child, rejects the turn (dispatcher sends the localized error)
// and the session map is cleaned so the next prompt respawns.
describe("per-turn watchdog (M-ACP-2)", () => {
  it("kills a hung child and rejects the turn within the timeout", async () => {
    const cfg: BridgeConfig = {
      agents: [
        {
          id: "hung",
          bot_token: "x",
          allowed_users: ["1"],
          cwd: "/home/agent/cerase/workspace",
          spawn: {
            command: "env",
            args: ["--", "FAKE_HANG_PROMPT=1", "node", FAKE_CHILD],
          },
        },
      ],
      session: { idle_timeout_minutes: 60, max_concurrent: 16 },
    } as unknown as BridgeConfig;
    const mgr = new SessionManager(cfg, undefined, { turnTimeoutMs: 500 });
    try {
      await expect(mgr.prompt("hung", "1", "ciao")).rejects.toThrow(/watchdog/i);
      // The hung child was killed and the session dropped — a fresh
      // prompt respawns (and hangs again → rejects again, proving the
      // queue is NOT blocked forever).
      await expect(mgr.prompt("hung", "1", "ancora")).rejects.toThrow(/watchdog/i);
    } finally {
      await mgr.shutdown();
    }
  }, 20_000);
});

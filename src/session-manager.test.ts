import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "./config.js";
import type { RestEndpoint } from "./opencode-rest.js";
import type { CanonicalMessage } from "./reconciler.js";
import { SessionManager, type SpawnFn, type TurnTelemetry } from "./session-manager.js";
import { CERASE_SESSION_MODE } from "./session-mode.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

function makeConfig(overrides?: {
  reply?: string;
  crashAfterPrompt?: boolean;
  idleTimeoutMinutes?: number;
  cwd?: string;
  lateBurstText?: string;
  lateBurstIntervalMs?: number;
  messageId?: string;
  loadSession?: boolean;
  loadFails?: boolean;
  modes?: string;
  modesShape?: "config" | "modes";
  echoMode?: boolean;
  mode?: string;
}): BridgeConfig {
  const env: string[] = [];
  if (overrides?.reply !== undefined) env.push(`FAKE_REPLY=${overrides.reply}`);
  if (overrides?.crashAfterPrompt) env.push("FAKE_CRASH_AFTER_PROMPT=1");
  if (overrides?.loadSession) env.push("FAKE_LOAD_SESSION=1");
  if (overrides?.loadFails) env.push("FAKE_LOAD_FAILS=1");
  if (overrides?.lateBurstText !== undefined) env.push(`FAKE_LATE_BURST_TEXT=${overrides.lateBurstText}`);
  if (overrides?.lateBurstIntervalMs !== undefined)
    env.push(`FAKE_LATE_BURST_INTERVAL_MS=${overrides.lateBurstIntervalMs}`);
  if (overrides?.messageId !== undefined) env.push(`FAKE_MESSAGE_ID=${overrides.messageId}`);
  if (overrides?.modes !== undefined) env.push(`FAKE_MODES=${overrides.modes}`);
  if (overrides?.modesShape !== undefined) env.push(`FAKE_MODES_SHAPE=${overrides.modesShape}`);
  if (overrides?.echoMode) env.push("FAKE_ECHO_MODE=1");
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
        mode: overrides?.mode ?? CERASE_SESSION_MODE,
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

  // Kill-on-failed-handshake is covered by the production catch in
  // spawnAndInit: a thrown initialize()/newSession() kills the child
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

  // A slot restart is ORDINARY, not exceptional: installing a skill rewrites
  // AGENTS.md and the entrypoint watcher SIGTERMs opencode, the idle killer
  // fires, the image is updated. Until these tests existed the bridge answered
  // the next message from a brand-new session and told nobody, which is the
  // mechanism behind "the assistant forgets". The session id is the only thing
  // that distinguishes the two outcomes — both reply, both look healthy.

  it("resumes the same opencode session after the slot restarts", async () => {
    mgr = new SessionManager(makeConfig({ reply: "x", loadSession: true }));
    await mgr.prompt("doc-qa", "user-A", "first");
    const before = mgr.currentSessionId("doc-qa", "user-A");
    expect(before).toBeDefined();

    // What the AGENTS.md watcher does to the slot, in one call.
    mgr.killAgentSessions("doc-qa");
    await vi.waitFor(() => expect(mgr.activeSessionCount()).toBe(0));

    const r = await mgr.prompt("doc-qa", "user-A", "second");
    expect(r.stopReason).toBe("end_turn");
    expect(mgr.currentSessionId("doc-qa", "user-A")).toBe(before);
  });

  it("starts a new session when the slot does not offer loadSession", async () => {
    // An older slot image. The conversation is still lost — but by the agent's
    // own declared capability, not by the bridge discarding a usable id.
    mgr = new SessionManager(makeConfig({ reply: "x" }));
    await mgr.prompt("doc-qa", "user-A", "first");
    const before = mgr.currentSessionId("doc-qa", "user-A");

    mgr.killAgentSessions("doc-qa");
    await vi.waitFor(() => expect(mgr.activeSessionCount()).toBe(0));

    await mgr.prompt("doc-qa", "user-A", "second");
    expect(mgr.currentSessionId("doc-qa", "user-A")).not.toBe(before);
  });

  it("falls back to a new session when the load is refused, and forgets the dead id", async () => {
    // The expected case after an image upgrade: the slot entrypoint wipes
    // opencode.db whenever the version stamp changes, so every id on the box
    // stops resolving. A refused load must cost a cold start, never a turn.
    mgr = new SessionManager(makeConfig({ reply: "x", loadSession: true, loadFails: true }));
    await mgr.prompt("doc-qa", "user-A", "first");
    const before = mgr.currentSessionId("doc-qa", "user-A");

    mgr.killAgentSessions("doc-qa");
    await vi.waitFor(() => expect(mgr.activeSessionCount()).toBe(0));

    const r = await mgr.prompt("doc-qa", "user-A", "second");
    expect(r.stopReason).toBe("end_turn");
    expect(mgr.currentSessionId("doc-qa", "user-A")).not.toBe(before);
  });

  it("remembers one resumable id per pair, not one per restart", async () => {
    mgr = new SessionManager(makeConfig({ reply: "x", loadSession: true }));
    for (let i = 0; i < 3; i += 1) {
      await mgr.prompt("doc-qa", "user-A", `turn ${i}`);
      mgr.killAgentSessions("doc-qa");
      await vi.waitFor(() => expect(mgr.activeSessionCount()).toBe(0));
    }
    expect(mgr.resumableSessionCount()).toBe(1);
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
    // (`fake-session-cwd=<cwd>#<pid>`), and the pid is what lets the resume
    // tests above tell a reloaded session from a re-created one — so match
    // the prefix rather than the whole string.
    mgr = new SessionManager(makeConfig({ reply: "ok", cwd: "/expected/path" }));
    await mgr.prompt("doc-qa", "user-A", "ping");
    expect(mgr.currentSessionId("doc-qa", "user-A")).toMatch(/^fake-session-cwd=\/expected\/path#\d+$/);
  });

  it("throws when prompting an unknown agent id", async () => {
    mgr = new SessionManager(makeConfig());
    await expect(mgr.prompt("ghost", "user-A", "x")).rejects.toThrow(/ghost/);
  });

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

  // session.max_concurrent is a real ceiling — a new session
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

describe("session mode", () => {
  let mgr: SessionManager;

  afterEach(async () => {
    if (mgr) await mgr.shutdown();
  });

  // The mode carries the Cerase profile. A slot rendered without it answers
  // as opencode's own agent, which is a different assistant wearing the
  // customer's name, so the session must not start rather than start wrong.
  it("refuses the session when the handshake advertises modes and the Cerase one is not among them", async () => {
    mgr = new SessionManager(makeConfig({ reply: "x", modes: "build,plan" }));
    await expect(mgr.prompt("doc-qa", "user-A", "ciao")).rejects.toThrow(/cerase/i);
    expect(mgr.activeSessionCount()).toBe(0);
    // The absence is a property of the slot, so it is answerable for the
    // agent and not only for the turn that happened to hit it.
    const failure = mgr.sessionModeFailure("doc-qa");
    expect(failure).toBeDefined();
    expect(failure?.agentId).toBe("doc-qa");
    expect(failure?.requested).toBe(CERASE_SESSION_MODE);
    expect(failure?.available).toEqual(["build", "plan"]);
    expect(failure?.detail).toMatch(/re-render/i);
  });

  // The absent mode is known from the handshake, so the request that cannot
  // succeed is never sent. Without this the bridge learns the same fact from
  // an error it caused.
  it("does not ask for a mode the handshake did not advertise", async () => {
    const asked: string[] = [];
    mgr = new SessionManager(makeConfig({ reply: "x", modes: "build,plan" }));
    const original = acp.ClientSideConnection.prototype.setSessionMode;
    const spy = vi.spyOn(acp.ClientSideConnection.prototype, "setSessionMode").mockImplementation(async function (
      this: acp.ClientSideConnection,
      params: acp.SetSessionModeRequest,
    ) {
      asked.push(params.modeId);
      return original.call(this, params);
    });
    try {
      await expect(mgr.prompt("doc-qa", "user-A", "ciao")).rejects.toThrow(/cerase/i);
      expect(asked).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  // The common case, and it has to stay quiet: the mode is advertised, it is
  // selected, and the session runs under it.
  it("selects the Cerase mode when the handshake advertises it", async () => {
    mgr = new SessionManager(makeConfig({ modes: `build,${CERASE_SESSION_MODE},plan`, echoMode: true }));
    const chunks: string[] = [];
    const result = await mgr.prompt("doc-qa", "user-A", "ciao", (update) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        chunks.push(update.content.text);
      }
    });
    expect(result.stopReason).toBe("end_turn");
    // The fixture answers with the mode it is actually in, so this asserts
    // the profile the turn ran under rather than that a call was made.
    expect(chunks.join("")).toBe(CERASE_SESSION_MODE);
    expect(mgr.sessionModeFailure("doc-qa")).toBeUndefined();
  });

  // The mode is a per-agent config value, not a constant. The health probe is
  // the caller that needed it: it asks for one word and the customer's own
  // assistant reasonably answers a paragraph, so it runs under an assistant of
  // its own instead.
  //
  // The fixture echoes the mode it is actually in, so this asserts which
  // profile the turn RAN under — not that some call was made with some
  // argument, which is the assertion that would still pass if the constant
  // were being used.
  it("selects the mode the agent's config names, not a built-in default", async () => {
    mgr = new SessionManager(
      makeConfig({ modes: `build,probe,${CERASE_SESSION_MODE}`, echoMode: true, mode: "probe" }),
    );
    const chunks: string[] = [];
    await mgr.prompt("doc-qa", "user-A", "ciao", (update) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        chunks.push(update.content.text);
      }
    });
    expect(chunks.join("")).toBe("probe");
    expect(chunks.join("")).not.toBe(CERASE_SESSION_MODE);
  });

  // A configured mode the slot does not define is the same fault as an absent
  // `cerase` and is reported the same way — per agent, naming what the slot
  // does offer. Nothing silently falls back to another assistant.
  it("refuses the session when the configured mode is not one the slot offers", async () => {
    mgr = new SessionManager(makeConfig({ modes: `build,${CERASE_SESSION_MODE}`, mode: "probe" }));
    await expect(mgr.prompt("doc-qa", "user-A", "ciao", () => {})).rejects.toThrow();
    const failure = mgr.sessionModeFailure("doc-qa");
    expect(failure?.requested).toBe("probe");
    expect(failure?.available).toContain(CERASE_SESSION_MODE);
  });

  // The protocol has two places to advertise modes and opencode uses the
  // configOptions one. A client that reads only the other is blind to every
  // agent that does what opencode does, so both are covered end to end.
  it("reads the advertisement from the modes object as well as from configOptions", async () => {
    mgr = new SessionManager(
      makeConfig({ modes: `build,${CERASE_SESSION_MODE}`, modesShape: "modes", echoMode: true }),
    );
    const chunks: string[] = [];
    await mgr.prompt("doc-qa", "user-A", "ciao", (update) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        chunks.push(update.content.text);
      }
    });
    expect(chunks.join("")).toBe(CERASE_SESSION_MODE);
  });

  // An agent that advertises no mode system at all is not a misrendered
  // slot: nothing in this deployment can add a mode to it, and refusing
  // would make the bridge unusable against an agent the protocol permits.
  it("keeps the session when the agent advertises no mode system", async () => {
    mgr = new SessionManager(makeConfig({ reply: "senza modi" }));
    const chunks: string[] = [];
    const result = await mgr.prompt("doc-qa", "user-A", "ciao", (update) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        chunks.push(update.content.text);
      }
    });
    expect(result.stopReason).toBe("end_turn");
    expect(chunks.join("")).toBe("senza modi");
    expect(mgr.sessionModeFailure("doc-qa")).toBeUndefined();
  });
});

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

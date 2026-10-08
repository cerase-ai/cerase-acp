import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RunBridgeHandle, runBridge } from "./bridge.js";
import type { ChatAdapter } from "./chat-adapter.js";
import { type AgentConfig, type BridgeConfig, loadConfig } from "./config.js";
import { type Dispatcher, pickSlowMessage } from "./dispatcher.js";
import { isChannelReady } from "./reachability.js";
import { workspaceChatListenerPort } from "./workspace-chat-adapter.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

function makeConfig(): BridgeConfig {
  return {
    agents: [
      {
        id: "doc-qa",
        channel: "discord",
        cwd: "/home/agent/cerase/workspace",
        mode: "cerase",
        bot_token: "tok-doc",
        allowed_users: ["111"],
        spawn: { command: "env", args: ["--", "FAKE_REPLY=hi", "node", FAKE_CHILD] },
      },
      {
        id: "policy-qa",
        channel: "discord",
        cwd: "/home/agent/cerase/workspace",
        mode: "cerase",
        bot_token: "tok-pol",
        allowed_users: ["222"],
        spawn: { command: "env", args: ["--", "FAKE_REPLY=hi", "node", FAKE_CHILD] },
      },
    ],
    session: { idle_timeout_minutes: 60, max_concurrent: 16 },
  };
}

interface FakeAdapter extends ChatAdapter {
  startCalls: number;
  stopCalls: number;
}

function makeFakeAdapter(agent: AgentConfig, _: Dispatcher, behaviour: "ok" | "fail"): FakeAdapter {
  const state: FakeAdapter = {
    agentId: agent.id,
    startCalls: 0,
    stopCalls: 0,
    async start() {
      state.startCalls += 1;
      if (behaviour === "fail") {
        throw new Error(`fake login failed for ${agent.id}`);
      }
    },
    async stop() {
      state.stopCalls += 1;
    },
    makeSendTarget() {
      return async () => {
        /* no-op in tests */
        // The send target reports a delivery outcome.
        return { ok: true };
      };
    },
  };
  return state;
}

describe("runBridge", () => {
  let handle: RunBridgeHandle | undefined;

  afterEach(async () => {
    if (handle) await handle.shutdown();
    handle = undefined;
    vi.unstubAllEnvs();
  });

  it("test-mode: all adapter logins fail → bridge stays up + test server reachable", async () => {
    const cfg = makeConfig();
    handle = await runBridge({
      config: cfg,
      bridgeE2eTest: true,
      testInjectionPort: 0, // ephemeral port for tests
      createAdapter: async (agent, dispatcher) => makeFakeAdapter(agent, dispatcher, "fail"),
    });
    expect(handle.testInjectionUrl).toBeDefined();
    // The test server must respond — even 404 to a stub path is fine,
    // we just need to prove the listener is up.
    const res = await fetch(`${handle.testInjectionUrl}/nope`);
    expect([200, 400, 404]).toContain(res.status);
  });

  it("test-mode: mixed success/failure → bridge still resolves", async () => {
    const cfg = makeConfig();
    let i = 0;
    handle = await runBridge({
      config: cfg,
      bridgeE2eTest: true,
      testInjectionPort: 0,
      createAdapter: async (agent, dispatcher) => {
        const behaviour = i++ === 0 ? "ok" : "fail";
        return makeFakeAdapter(agent, dispatcher, behaviour);
      },
    });
    expect(handle.testInjectionUrl).toBeDefined();
  });

  // Exiting stays right when nothing would be left to answer for the bridge.
  // Without the internal secret no internal server is started, so a bridge
  // that stayed up carrying nothing would be a process the orchestrator reads
  // as running and no probe contradicts. The restart loop is the only signal
  // available in that configuration, so take it.
  it("production mode: every adapter fails and no internal server is configured → runBridge rejects", async () => {
    const cfg = makeConfig();
    vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", "");
    await expect(
      runBridge({
        config: cfg,
        bridgeE2eTest: false,
        createAdapter: async (agent, dispatcher) => makeFakeAdapter(agent, dispatcher, "fail"),
      }),
    ).rejects.toThrow();
  });

  // One assistant is the case the total-failure branch got wrong. With no
  // second adapter to hold the bridge above the threshold, a refused token
  // tore the internal server down and threw, so the orchestrator restarted a
  // container whose failure block nobody could read — the same invisible loop
  // one layer out. The bridge now stays up to answer for itself, and reports
  // itself un-servable so the container cannot pass for healthy meanwhile.
  it("production mode: the only adapter's credential is refused → bridge stays up, unhealthy, and names the credential", async () => {
    const SECRET = "solo-refused-secret";
    vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
    vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");

    const cfg: BridgeConfig = {
      agents: [
        {
          id: "solo",
          channel: "discord",
          cwd: "/home/agent/cerase/workspace",
          mode: "cerase",
          bot_token: "tok",
          allowed_users: ["111"],
          spawn: { command: "true", args: [] },
        },
      ],
      session: { idle_timeout_minutes: 60, max_concurrent: 16 },
    };

    handle = await runBridge({
      config: cfg,
      bridgeE2eTest: false,
      createAdapter: async (agent, dispatcher) => {
        const a = makeFakeAdapter(agent, dispatcher, "ok");
        a.start = async () => {
          a.startCalls += 1;
          const err = new Error("An invalid token was provided.") as Error & { code: string };
          err.code = "TokenInvalid";
          throw err;
        };
        return a;
      },
    });

    // Still listening: without this there is nowhere to read the reason.
    expect(handle.internalUrl).toBeDefined();

    const health = await fetch(`${handle.internalUrl}/healthz`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ status: "no_chat_transport" });

    const statusRes = await fetch(`${handle.internalUrl}/internal/status`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as {
      agents: Array<{ id: string; ready: boolean | null; failure?: { kind: string; credential: string } }>;
    };
    expect(status.agents).toHaveLength(1);
    expect(status.agents[0]!.ready).toBe(false);
    expect(status.agents[0]!.failure?.kind).toBe("credential_rejected");
    expect(status.agents[0]!.failure?.credential).toBe("bot_token");
  });

  // The second thing the exit cost: a one-agent box whose single adapter hit
  // a transient failure had its retry timer cancelled by the teardown, so a
  // condition that resolves itself in seconds became a permanent crash-loop.
  it("production mode: the only adapter fails transiently → bridge stays up un-servable and self-heals to healthy", async () => {
    vi.useFakeTimers();
    try {
      const SECRET = "solo-transient-secret";
      vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
      vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");
      vi.stubEnv("CERASE_ACP_ADAPTER_RETRY_BASE_MS", "1000");
      vi.stubEnv("CERASE_ACP_ADAPTER_RETRY_MAX_MS", "5000");

      const cfg: BridgeConfig = {
        agents: [
          {
            id: "solo",
            channel: "discord",
            cwd: "/home/agent/cerase/workspace",
            mode: "cerase",
            bot_token: "tok",
            allowed_users: ["111"],
            spawn: { command: "true", args: [] },
          },
        ],
        session: { idle_timeout_minutes: 60, max_concurrent: 16 },
      };

      let live = false;
      let failsLeft = 1;
      const adapter: FakeAdapter & { ready(): boolean } = {
        agentId: "solo",
        startCalls: 0,
        stopCalls: 0,
        async start() {
          adapter.startCalls += 1;
          if (failsLeft > 0) {
            failsLeft -= 1;
            throw new Error("transient login failure for solo");
          }
          live = true;
        },
        async stop() {
          adapter.stopCalls += 1;
          live = false;
        },
        ready: () => live,
        makeSendTarget: () => async () => ({ ok: true }),
      };

      handle = await runBridge({
        config: cfg,
        bridgeE2eTest: false,
        createAdapter: async () => adapter,
      });

      expect(adapter.startCalls).toBe(1);
      expect((await fetch(`${handle.internalUrl}/healthz`)).status).toBe(503);

      // Past the jittered backoff the supervisor retries; the timer survived
      // because nothing tore the bridge down.
      await vi.advanceTimersByTimeAsync(5000);
      expect(adapter.startCalls).toBe(2);
      expect((await fetch(`${handle.internalUrl}/healthz`)).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("production mode: one adapter fails, one succeeds → bridge stays up, status truthful, inject works", async () => {
    const cfg = makeConfig(); // doc-qa allows 111, policy-qa allows 222
    const SECRET = "m22-secret";
    vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
    vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0"); // ephemeral port

    const made: Record<string, FakeAdapter> = {};
    handle = await runBridge({
      config: cfg,
      bridgeE2eTest: false,
      createAdapter: async (agent, dispatcher) => {
        // doc-qa simulates the invalid Discord token; policy-qa is the healthy
        // (web/maintainer-style) transport that must survive.
        const a = makeFakeAdapter(agent, dispatcher, agent.id === "doc-qa" ? "fail" : "ok");
        made[agent.id] = a;
        return a;
      },
    });

    // Bridge resolved despite doc-qa.start() rejecting; both starts attempted.
    expect(made["doc-qa"]!.startCalls).toBe(1);
    expect(made["policy-qa"]!.startCalls).toBe(1);
    expect(handle.internalUrl).toBeDefined();

    // /internal/status is truthful: the failed adapter reports ready:false
    // (not null), the healthy one is present.
    const statusRes = await fetch(`${handle.internalUrl}/internal/status`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as {
      agents: Array<{ id: string; ready: boolean | null; turnsInFlight?: number }>;
    };
    expect(status.agents.find((a) => a.id === "doc-qa")?.ready).toBe(false);
    expect(status.agents.find((a) => a.id === "policy-qa")).toBeDefined();

    // Every agent carries its outstanding-turn count, and zero is a value
    // rather than an absence. The control-plane reads it before it replaces an
    // AGENTS.md, so a field that is simply missing would be read as "cannot
    // tell" and the change would be held back on an assistant doing nothing.
    for (const a of status.agents) {
      expect(a.turnsInFlight).toBe(0);
    }

    // Inject to the healthy agent (allowed user 222) succeeds end-to-end.
    const injectRes = await fetch(`${handle.internalUrl}/internal/inject`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ agent_id: "policy-qa", user_id: "222", text: "ciao", surface_in_chat: false }),
    });
    expect(injectRes.status).toBe(202);
  });

  // A token the provider refuses will not start working, so the retry loop
  // that used to run against it hid a dead assistant instead of reporting
  // one. The bridge must stop retrying and say on /internal/status which
  // agent is down and which credential was refused.
  it("production mode: a rejected Discord token stops the retries and is named on /internal/status", async () => {
    const cfg = makeConfig();
    const SECRET = "rejected-credential-secret";
    vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
    vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");
    // A backoff short enough that the unfixed loop would fire several times
    // inside this test's wait, and slow enough not to be flaky.
    vi.stubEnv("CERASE_ACP_ADAPTER_RETRY_BASE_MS", "20");
    vi.stubEnv("CERASE_ACP_ADAPTER_RETRY_MAX_MS", "20");

    const made: Record<string, FakeAdapter> = {};
    handle = await runBridge({
      config: cfg,
      bridgeE2eTest: false,
      createAdapter: async (agent, dispatcher) => {
        const a = makeFakeAdapter(agent, dispatcher, agent.id === "doc-qa" ? "fail" : "ok");
        if (agent.id === "doc-qa") {
          a.start = async () => {
            a.startCalls += 1;
            const err = new Error("An invalid token was provided.") as Error & { code: string };
            err.code = "TokenInvalid";
            throw err;
          };
        }
        made[agent.id] = a;
        return a;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    // One attempt, and no retry after it.
    expect(made["doc-qa"]!.startCalls).toBe(1);

    const statusRes = await fetch(`${handle.internalUrl}/internal/status`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as {
      agents: Array<{
        id: string;
        ready: boolean | null;
        failure?: { kind: string; code: string; credential: string; detail: string };
      }>;
    };
    const down = status.agents.find((a) => a.id === "doc-qa");
    expect(down?.ready).toBe(false);
    expect(down?.failure).toBeDefined();
    expect(down?.failure?.kind).toBe("credential_rejected");
    expect(down?.failure?.code).toBe("TokenInvalid");
    expect(down?.failure?.credential).toBe("bot_token");
    expect(down?.failure?.detail).toBeTruthy();

    // The healthy agent carries no failure block.
    expect(status.agents.find((a) => a.id === "policy-qa")?.failure).toBeUndefined();
  });

  // A bot whose application never had Message Content ticked in the Discord
  // developer portal. discord.js rejects login() with a bare Error carrying
  // the library's sentence and no code, and the bridge retried it every
  // backoff while its replies were dropped and nobody was told. Both ways a
  // start() can fail are covered: at boot, and on a retry armed by an earlier
  // failure that could pass.
  describe("production mode: a Discord application without the Message Content intent", () => {
    const SECRET = "disallowed-intents-secret";
    const PORTAL_SENTENCE =
      "The Discord application behind this bot token is not granted the Message Content intent. Enable it in the developer portal, under Bot and then Privileged Gateway Intents.";

    async function statusOf(agentId: string) {
      const res = await fetch(`${handle?.internalUrl}/internal/status`, {
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        agents: Array<{ id: string; ready: boolean | null; failure?: Record<string, unknown> }>;
      };
      return body.agents.find((a) => a.id === agentId);
    }

    /** doc-qa's start() throws what `failures` lists, in order, then the last one for ever. */
    async function runWith(failures: Error[]): Promise<FakeAdapter> {
      vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
      vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");
      // Short enough that a loop still retrying would fire several times
      // inside the wait below.
      vi.stubEnv("CERASE_ACP_ADAPTER_RETRY_BASE_MS", "20");
      vi.stubEnv("CERASE_ACP_ADAPTER_RETRY_MAX_MS", "20");
      let docQa: FakeAdapter | undefined;
      handle = await runBridge({
        config: makeConfig(),
        bridgeE2eTest: false,
        createAdapter: async (agent, dispatcher) => {
          const a = makeFakeAdapter(agent, dispatcher, "ok");
          if (agent.id === "doc-qa") {
            a.start = async () => {
              a.startCalls += 1;
              throw failures[Math.min(a.startCalls, failures.length) - 1];
            };
            docQa = a;
          }
          return a;
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      return docQa!;
    }

    it("refused at boot: no retry, and /internal/status names the refusal with the portal sentence", async () => {
      const docQa = await runWith([new Error("Used disallowed intents")]);

      expect(docQa.startCalls).toBe(1);
      const down = await statusOf("doc-qa");
      expect(down?.ready).toBe(false);
      expect(down?.failure).toEqual({
        kind: "credential_rejected",
        code: "DisallowedIntents",
        credential: "bot_token",
        detail: PORTAL_SENTENCE,
      });
      expect((await statusOf("policy-qa"))?.failure).toBeUndefined();
    });

    it("refused on a retry: the retries stop there, and /internal/status names the refusal", async () => {
      const docQa = await runWith([new Error("Connect Timeout Error"), new Error("Used disallowed intents")]);

      // The boot attempt, then the one retry that met the refusal.
      expect(docQa.startCalls).toBe(2);
      const down = await statusOf("doc-qa");
      expect(down?.ready).toBe(false);
      expect(down?.failure).toEqual({
        kind: "credential_rejected",
        code: "DisallowedIntents",
        credential: "bot_token",
        detail: PORTAL_SENTENCE,
      });
    });
  });

  // /internal/inject acks 202 at acceptance (validation + allowlist) and runs
  // the turn detached, so a slow model turn no longer trips the
  // control-plane's fire-and-forget timeout. A swallowed turn/delivery
  // failure must surface in the additive `inject` block of GET
  // /internal/status — never a silent 202-then-nothing. This drives the real
  // production dispatcher: doc-qa's channel is "down" (every send reports
  // `{ ok: false }`) → recorded as the last inject failure; policy-qa's send
  // succeeds → counted as succeeded.
  it("production mode: /internal/inject acks 202; a detached delivery failure surfaces in the status inject block", async () => {
    const cfg = makeConfig(); // doc-qa allows 111, policy-qa allows 222
    const SECRET = "faillooud-secret";
    vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
    vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");

    handle = await runBridge({
      config: cfg,
      bridgeE2eTest: false,
      createAdapter: async (agent, dispatcher) => {
        const a = makeFakeAdapter(agent, dispatcher, "ok");
        // doc-qa's channel can't deliver; policy-qa's delivers fine.
        const deliverOk = agent.id === "policy-qa";
        a.makeSendTarget = () => async () =>
          deliverOk ? { ok: true } : { ok: false, error: new Error("channel down") };
        return a;
      },
    });
    expect(handle.internalUrl).toBeDefined();

    const inject = (agentId: string, userId: string) =>
      fetch(`${handle?.internalUrl}/internal/inject`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ agent_id: agentId, user_id: userId, text: "ciao", surface_in_chat: false }),
      });

    // Both injects pass validation + allowlist → 202 accepted; the turn +
    // delivery run as a detached background task.
    const failRes = await inject("doc-qa", "111");
    expect(failRes.status).toBe(202);
    const okRes = await inject("policy-qa", "222");
    expect(okRes.status).toBe(202);

    // The detached outcomes surface in the `inject` block of
    // GET /internal/status: doc-qa's delivery failure is recorded as
    // last_failure (fail loud), policy-qa's turn as a success.
    await vi.waitFor(
      async () => {
        const res = await fetch(`${handle?.internalUrl}/internal/status`, {
          headers: { authorization: `Bearer ${SECRET}` },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          inject: { in_flight: number; succeeded: number; failed: number; last_failure: { agent_id: string } | null };
        };
        expect(body.inject.in_flight).toBe(0);
        expect(body.inject.failed).toBe(1);
        expect(body.inject.succeeded).toBe(1);
        expect(body.inject.last_failure?.agent_id).toBe("doc-qa");
      },
      { timeout: 8000, interval: 100 },
    );
  });

  // A slot that does not define the Cerase mode answers nothing, and looks
  // fine from every other angle: its channel is connected, `ready` is true,
  // and no start() ever failed. The status endpoint is where that has to be
  // legible, or the only trace of a dead assistant is the refusal in a log.
  it("production mode: a slot missing the Cerase session mode is named on /internal/status", async () => {
    const cfg = makeConfig();
    // doc-qa's slot offers modes and not the one the assistant runs under;
    // policy-qa's offers it. Same bridge, same code path, one difference.
    cfg.agents[0]!.spawn = { command: "env", args: ["--", "FAKE_MODES=build,plan", "node", FAKE_CHILD] };
    cfg.agents[1]!.spawn = { command: "env", args: ["--", "FAKE_MODES=build,cerase,plan", "node", FAKE_CHILD] };
    const SECRET = "session-mode-secret";
    vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
    vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");

    handle = await runBridge({
      config: cfg,
      bridgeE2eTest: false,
      createAdapter: async (agent, dispatcher) => makeFakeAdapter(agent, dispatcher, "ok"),
    });

    const inject = (agentId: string, userId: string) =>
      fetch(`${handle?.internalUrl}/internal/inject`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ agent_id: agentId, user_id: userId, text: "ciao", surface_in_chat: false }),
      });

    expect((await inject("doc-qa", "111")).status).toBe(202);
    expect((await inject("policy-qa", "222")).status).toBe(202);

    await vi.waitFor(
      async () => {
        const res = await fetch(`${handle?.internalUrl}/internal/status`, {
          headers: { authorization: `Bearer ${SECRET}` },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          agents: Array<{
            id: string;
            ready: boolean | null;
            failure?: { kind: string; mode?: string; available?: string[]; detail?: string };
          }>;
        };
        const down = body.agents.find((a) => a.id === "doc-qa");
        expect(down?.failure?.kind).toBe("session_mode_missing");
        expect(down?.failure?.mode).toBe("cerase");
        expect(down?.failure?.available).toEqual(["build", "plan"]);
        expect(down?.failure?.detail).toBeTruthy();
        // The agent whose slot has the mode carries no failure block, so a
        // reader is not shown a fault on every agent the moment one has one.
        expect(body.agents.find((a) => a.id === "policy-qa")?.failure).toBeUndefined();
      },
      { timeout: 8000, interval: 100 },
    );
  });

  // A transient start() failure must recover on its own: the supervisor
  // retries on a backoff and the agent flips not-ready → ready without a
  // container restart, while the bridge never throws. Mirrors the real
  // deployment: a healthy web/maintainer transport keeps the bridge above the
  // total-failure threshold while the discord channel self-heals.
  it("production mode: a transient start() failure self-heals after a backoff tick", async () => {
    vi.useFakeTimers();
    try {
      const SECRET = "m23-secret";
      vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
      vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");
      vi.stubEnv("CERASE_ACP_ADAPTER_RETRY_BASE_MS", "1000");
      vi.stubEnv("CERASE_ACP_ADAPTER_RETRY_MAX_MS", "5000");

      const cfg: BridgeConfig = {
        agents: [
          {
            id: "web",
            channel: "discord",
            cwd: "/home/agent/cerase/workspace",
            mode: "cerase",
            bot_token: "n/a",
            allowed_users: ["111"],
            spawn: { command: "true", args: [] },
          },
          {
            id: "discordy",
            channel: "discord",
            cwd: "/home/agent/cerase/workspace",
            mode: "cerase",
            bot_token: "tok",
            allowed_users: ["111"],
            spawn: { command: "true", args: [] },
          },
        ],
        session: { idle_timeout_minutes: 60, max_concurrent: 16 },
      };

      // `web` always starts (keeps the bridge up). `discordy` fails its first
      // start() (transient) then succeeds on the retry; ready() reflects the
      // live connection like the real discord.js client.isReady().
      const liveById: Record<string, boolean> = {};
      const failsLeftById: Record<string, number> = { web: 0, discordy: 1 };
      const makeAdapter = (agentId: string): FakeAdapter & { ready(): boolean } => ({
        agentId,
        startCalls: 0,
        stopCalls: 0,
        async start() {
          (this as FakeAdapter).startCalls += 1;
          const failsLeft = failsLeftById[agentId] ?? 0;
          if (failsLeft > 0) {
            failsLeftById[agentId] = failsLeft - 1;
            throw new Error(`transient login failure for ${agentId}`);
          }
          liveById[agentId] = true;
        },
        async stop() {
          (this as FakeAdapter).stopCalls += 1;
          liveById[agentId] = false;
        },
        ready: () => liveById[agentId] === true,
        makeSendTarget: () => async () => ({ ok: true }),
      });

      const made: Record<string, FakeAdapter> = {};
      handle = await runBridge({
        config: cfg,
        bridgeE2eTest: false,
        createAdapter: async (agent) => {
          const a = makeAdapter(agent.id);
          made[agent.id] = a;
          return a;
        },
      });

      const getReady = async (id: string) => {
        const res = await fetch(`${handle?.internalUrl}/internal/status`, {
          headers: { authorization: `Bearer ${SECRET}` },
        });
        const body = (await res.json()) as { agents: Array<{ id: string; ready: boolean | null }> };
        return body.agents.find((a) => a.id === id)?.ready;
      };

      // discordy's first start failed → bridge stayed up, it's concretely
      // not-ready; the healthy web transport is ready.
      expect(made.discordy!.startCalls).toBe(1);
      expect(await getReady("discordy")).toBe(false);
      expect(await getReady("web")).toBe(true);

      // Advance past the (jittered) backoff → supervisor retries and recovers.
      await vi.advanceTimersByTimeAsync(5000);
      expect(made.discordy!.startCalls).toBe(2);
      expect(await getReady("discordy")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // The session block reaches the running bridge on a reload, and the status
  // endpoint says which limits it is running under. Only the session block
  // changes here, so no agent is added, removed or modified and the agent diff
  // alone would have applied nothing.
  it("a reload that changes only the session limits reaches the running bridge", async () => {
    const SECRET = "session-reload-secret";
    const yaml = (silence: number) => `
agents:
  - id: solo
    bot_token: tok-1
    allowed_users: ["111"]
    spawn:
      command: "true"
      args: []
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
  turn_silence_seconds: ${silence}
`;
    const dir = mkdtempSync(join(tmpdir(), "bridge-session-reload-"));
    const cfgPath = join(dir, "agents.yaml");
    writeFileSync(cfgPath, yaml(180));
    vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
    vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");
    try {
      handle = await runBridge({
        config: loadConfig(cfgPath, process.env),
        bridgeE2eTest: false,
        configPath: cfgPath,
        createAdapter: async (agent, d) => makeFakeAdapter(agent, d, "ok"),
      });
      const silence = async () => {
        const res = await fetch(`${handle?.internalUrl}/internal/status`, {
          headers: { authorization: `Bearer ${SECRET}` },
        });
        const body = (await res.json()) as { session?: { turn_silence_seconds?: number } };
        return body.session?.turn_silence_seconds;
      };
      expect(await silence()).toBe(180);
      writeFileSync(cfgPath, yaml(360));
      await vi.waitFor(async () => expect(await silence()).toBe(360), { timeout: 8000, interval: 25 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A config reload respawns an adapter and starts it. A start() that failed
  // there was logged and then left alone: no retry, and the boot path's
  // supervisor never heard about it. An operator who corrected a token while
  // the provider was having a bad minute got an assistant that stayed down
  // until someone restarted the container. Both paths have to reach the same
  // supervisor, or the answer to a transient failure depends on which of them
  // the adapter came through.
  describe("a config reload starts adapters through the same supervisor as boot", () => {
    const RELOAD_YAML = (token: string) => `
agents:
  - id: solo
    bot_token: ${token}
    allowed_users: ["111"]
    spawn:
      command: "true"
      args: []
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`;

    /**
     * Boots a one-agent bridge watching a real agents.yaml, then rewrites the
     * bot_token so the reloader classifies it as a respawn. The adapter the
     * respawn creates fails its first start() with `failure`; the boot one
     * always starts. Returns a getter for the respawned adapter.
     */
    async function bootAndRespawn(
      secret: string,
      failure: () => Error,
    ): Promise<{ dir: string; respawned: () => (FakeAdapter & { ready(): boolean }) | undefined }> {
      const dir = mkdtempSync(join(tmpdir(), "bridge-reload-"));
      const cfgPath = join(dir, "agents.yaml");
      writeFileSync(cfgPath, RELOAD_YAML("tok-1"));

      let created = 0;
      let second: (FakeAdapter & { ready(): boolean }) | undefined;
      const makeAdapter = (): FakeAdapter & { ready(): boolean } => {
        const generation = ++created;
        let failsLeft = generation === 1 ? 0 : 1;
        let live = false;
        const a: FakeAdapter & { ready(): boolean } = {
          agentId: "solo",
          startCalls: 0,
          stopCalls: 0,
          async start() {
            a.startCalls += 1;
            if (failsLeft > 0) {
              failsLeft -= 1;
              throw failure();
            }
            live = true;
          },
          async stop() {
            a.stopCalls += 1;
            live = false;
          },
          ready: () => live,
          makeSendTarget: () => async () => ({ ok: true }),
        };
        if (generation === 2) second = a;
        return a;
      };

      vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", secret);
      vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");
      vi.stubEnv("CERASE_ACP_ADAPTER_RETRY_BASE_MS", "20");
      vi.stubEnv("CERASE_ACP_ADAPTER_RETRY_MAX_MS", "20");

      handle = await runBridge({
        config: loadConfig(cfgPath, process.env),
        bridgeE2eTest: false,
        configPath: cfgPath,
        createAdapter: async () => makeAdapter(),
      });

      // A new bot_token is classified `bot_token_or_spawn` → respawn.
      writeFileSync(cfgPath, RELOAD_YAML("tok-2"));
      await vi.waitFor(() => expect(second?.startCalls).toBeGreaterThanOrEqual(1), { timeout: 8000, interval: 25 });

      return { dir, respawned: () => second };
    }

    it("a transient failure on the reload path is retried until it connects", async () => {
      const SECRET = "reload-retry-secret";
      const { dir, respawned } = await bootAndRespawn(SECRET, () => new Error("transient login failure on respawn"));
      try {
        // The retry the boot path would have scheduled, on the reload path.
        await vi.waitFor(() => expect(respawned()?.startCalls).toBe(2), { timeout: 8000, interval: 25 });

        // And the recovery reaches where an operator reads it.
        await vi.waitFor(
          async () => {
            const res = await fetch(`${handle?.internalUrl}/internal/status`, {
              headers: { authorization: `Bearer ${SECRET}` },
            });
            const body = (await res.json()) as { agents: Array<{ id: string; ready: boolean | null }> };
            expect(body.agents.find((a) => a.id === "solo")?.ready).toBe(true);
          },
          { timeout: 8000, interval: 25 },
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("a refused credential on the reload path is terminal, not retried", async () => {
      // The other half of the same mechanism: giving the reload path a
      // supervisor must not give it a loop against a verdict the provider
      // will keep returning.
      const SECRET = "reload-terminal-secret";
      const { dir, respawned } = await bootAndRespawn(SECRET, () => {
        const err = new Error("An invalid token was provided.") as Error & { code: string };
        err.code = "TokenInvalid";
        return err;
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(respawned()?.startCalls).toBe(1);

        const res = await fetch(`${handle?.internalUrl}/internal/status`, {
          headers: { authorization: `Bearer ${SECRET}` },
        });
        const body = (await res.json()) as {
          agents: Array<{ id: string; ready: boolean | null; failure?: { kind: string; code: string } }>;
        };
        const down = body.agents.find((a) => a.id === "solo");
        expect(down?.ready).toBe(false);
        expect(down?.failure?.kind).toBe("credential_rejected");
        expect(down?.failure?.code).toBe("TokenInvalid");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("production mode: all adapters succeed → bridge resolves + no test server", async () => {
    const cfg = makeConfig();
    handle = await runBridge({
      config: cfg,
      bridgeE2eTest: false,
      createAdapter: async (agent, dispatcher) => makeFakeAdapter(agent, dispatcher, "ok"),
    });
    expect(handle.testInjectionUrl).toBeUndefined();
  });

  it("test-mode: /_test/inject end-to-end — reply is observable via /_test/last-reply", async () => {
    // Regression test for a bug caught in a manual smoke test:
    // bridge.ts wired ONE dispatcher whose send-target was the discord
    // adapter; when the test-injection endpoint drove that dispatcher,
    // replies tried to flow into a not-logged-in Discord client and
    // either crashed (unauthorised → 500) or were swallowed by the
    // send-queue's error handler (authorised → 202 but no reply
    // recorded). Fix: a separate dispatcher for the test-injection
    // path whose send-target records into the test server.
    const cfg: BridgeConfig = {
      agents: [
        {
          id: "demo",
          channel: "discord",
          cwd: "/home/agent/cerase/workspace",
          mode: "cerase",
          bot_token: "fake-token",
          allowed_users: ["111"],
          spawn: {
            command: "env",
            args: ["--", "FAKE_REPLY=test injection works!", "node", FAKE_CHILD],
          },
        },
      ],
      session: { idle_timeout_minutes: 60, max_concurrent: 16 },
    };
    handle = await runBridge({
      config: cfg,
      bridgeE2eTest: true,
      testInjectionPort: 0,
      createAdapter: async (agent, dispatcher) => makeFakeAdapter(agent, dispatcher, "fail"),
    });
    const url = handle.testInjectionUrl!;

    // Authorised user → fake-child reply must be recorded
    const injectRes = await fetch(`${url}/_test/inject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "demo", user_id: "111", text: "ciao" }),
    });
    expect(injectRes.status).toBe(202);
    const replyRes = await fetch(`${url}/_test/last-reply?agent_id=demo&user_id=111`);
    expect(replyRes.status).toBe(200);
    const reply = (await replyRes.json()) as { text: string };
    // No disclaimer precedes the reply.
    expect(reply.text).toContain("test injection works!");
    expect(reply.text).not.toMatch(/assistente AI|AI assistant/);

    // Unauthorised user → polite refusal recorded (not a 500)
    const refusalInject = await fetch(`${url}/_test/inject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "demo", user_id: "999", text: "ciao" }),
    });
    expect(refusalInject.status).toBe(202);
    const refusalReply = await fetch(`${url}/_test/last-reply?agent_id=demo&user_id=999`);
    expect(refusalReply.status).toBe(200);
    const refusalBody = (await refusalReply.json()) as { text: string };
    expect(refusalBody.text).toMatch(/non sono ancora autorizzato|not authorised/i);
  });

  it("shutdown() stops adapters + closes test server cleanly", async () => {
    const cfg = makeConfig();
    const adapters: FakeAdapter[] = [];
    handle = await runBridge({
      config: cfg,
      bridgeE2eTest: true,
      testInjectionPort: 0,
      createAdapter: async (agent, dispatcher) => {
        const a = makeFakeAdapter(agent, dispatcher, "ok");
        adapters.push(a);
        return a;
      },
    });
    expect(adapters.every((a) => a.startCalls === 1)).toBe(true);
    await handle.shutdown();
    handle = undefined; // afterEach must not re-call
    expect(adapters.every((a) => a.stopCalls === 1)).toBe(true);
  });
});

// The reply that shipped carried a real attach marker and a closing sentence
// claiming the work was delivered, in one message. This drives the whole path
// the appliance runs -- production dispatcher, real ACP child over stdio, the
// real workspace read against a real docker daemon, the real internal status
// surface. Only the chat transport is faked, which is also the one thing a
// test cannot own.
describe("an attach that never arrives cannot close as a delivered turn", () => {
  let handle: RunBridgeHandle | undefined;

  afterEach(async () => {
    if (handle) await handle.shutdown();
    handle = undefined;
    vi.unstubAllEnvs();
  });

  const REPLY =
    "Fatto, Paolo. Tre slide sul progetto Falco, renderizzate in PDF. [[attach: outputs/falco-presentation.PDF]]";

  it("posts the failure notice, never uploads, and records the turn as failed", async () => {
    const SECRET = "attach-secret";
    vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
    vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");

    // The container the bridge derives from this agent id does not exist, so
    // the workspace read fails the way it failed on the box: a real docker
    // exec answered by a real daemon, not a rejection a stub decided on.
    const cfg: BridgeConfig = {
      agents: [
        {
          id: "attach-probe",
          channel: "discord",
          cwd: "/home/agent/cerase/workspace",
          mode: "cerase",
          bot_token: "irrelevant",
          allowed_users: ["111"],
          spawn: { command: "env", args: ["--", `FAKE_REPLY=${REPLY}`, "node", FAKE_CHILD] },
        },
      ],
      session: { idle_timeout_minutes: 60, max_concurrent: 16 },
    };

    const chat: string[] = [];
    let sendFileCalls = 0;
    handle = await runBridge({
      config: cfg,
      bridgeE2eTest: false,
      createAdapter: async (agent, dispatcher) => {
        const a = makeFakeAdapter(agent, dispatcher, "ok");
        a.makeSendTarget = () => async (chunk: string) => {
          chat.push(chunk);
          return { ok: true };
        };
        a.sendFile = async () => {
          sendFileCalls += 1;
          return { ok: true };
        };
        return a;
      },
    });
    expect(handle.internalUrl).toBeDefined();

    const res = await fetch(`${handle.internalUrl}/internal/inject`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ agent_id: "attach-probe", user_id: "111", text: "ciao", surface_in_chat: false }),
    });
    expect(res.status).toBe(202);

    // The turn is recorded as a failure, not as one more delivered inject.
    await vi.waitFor(
      async () => {
        const s = await fetch(`${handle?.internalUrl}/internal/status`, {
          headers: { authorization: `Bearer ${SECRET}` },
        });
        expect(s.status).toBe(200);
        const body = (await s.json()) as {
          inject: { in_flight: number; succeeded: number; failed: number; last_failure: { agent_id: string } | null };
        };
        expect(body.inject.in_flight).toBe(0);
        expect(body.inject.failed).toBe(1);
        expect(body.inject.succeeded).toBe(0);
        expect(body.inject.last_failure?.agent_id).toBe("attach-probe");
      },
      { timeout: 8000, interval: 100 },
    );

    const transcript = chat.join("\n");
    // The person is told the file did not arrive, in the language of the
    // conversation and by the file's name rather than its workspace path.
    expect(transcript).toMatch(/Non sono riuscita a recuperare falco-presentation\.PDF/);
    expect(transcript).not.toContain("outputs/falco-presentation");
    // Nothing was uploaded: the file could not be read at all.
    expect(sendFileCalls).toBe(0);
    // One injected message, two model replies: the assistant was prompted a
    // second time on the same session, which is where it is told what did not
    // arrive. What it is told is asserted on the prompt itself in the
    // dispatcher suite; here the point is that the second turn happens at all.
    expect(chat.filter((c) => c.includes("Tre slide sul progetto Falco")).length).toBe(2);
  });
});

// The production send path, end to end: the agent streams a summary inside a
// turn, the bridge's own per-piece filter sees it in fragments, and the
// dispatcher is what keeps it out of the chat. What is withheld is still
// captured as the assistant's rolling summary, as the send path does for one it
// withholds whole. A reply that was only the summary has not answered the
// person, so the turn is asked again as an empty one is.
describe("a summary the agent streams inside a turn", () => {
  let handle: RunBridgeHandle | undefined;
  let controlPlane: Server | undefined;

  afterEach(async () => {
    if (handle) await handle.shutdown();
    handle = undefined;
    await new Promise<void>((resolve) => (controlPlane ? controlPlane.close(() => resolve()) : resolve()));
    controlPlane = undefined;
    vi.unstubAllEnvs();
  });

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

  it("never reaches the chat, is captured whole, and the person is answered", async () => {
    // Stands in for the control-plane: records the summary capture and
    // answers everything else with a 404, which the bridge treats as the
    // control-plane being unavailable and proceeds without.
    const captured: { agent_id: string; summary: string }[] = [];
    controlPlane = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/api/internal/session-summary") {
          captured.push(JSON.parse(body));
          res.writeHead(200).end("{}");
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => controlPlane?.listen(0, "127.0.0.1", () => resolve()));
    const cpPort = (controlPlane.address() as AddressInfo).port;

    const SECRET = "summary-secret";
    vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
    vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");
    vi.stubEnv("CERASE_INTERNAL_SECRET", "control-plane-secret");
    vi.stubEnv("CERASE_CONTROL_PLANE_URL", `http://127.0.0.1:${cpPort}`);

    // Ten chunks of about fifty characters, the shape it streamed in.
    const cfg: BridgeConfig = {
      agents: [
        {
          id: "summary-probe",
          channel: "discord",
          cwd: "/home/agent/cerase/workspace",
          mode: "cerase",
          bot_token: "irrelevant",
          allowed_users: ["111"],
          spawn: {
            command: "env",
            args: ["--", `FAKE_REPLY=${SUMMARY}`, "FAKE_CHUNKS=10", "node", FAKE_CHILD],
          },
        },
      ],
      session: { idle_timeout_minutes: 60, max_concurrent: 16 },
    };

    const chat: string[] = [];
    handle = await runBridge({
      config: cfg,
      bridgeE2eTest: false,
      createAdapter: async (agent, dispatcher) => {
        const a = makeFakeAdapter(agent, dispatcher, "ok");
        a.makeSendTarget = () => async (chunk: string) => {
          chat.push(chunk);
          return { ok: true };
        };
        return a;
      },
    });

    const res = await fetch(`${handle.internalUrl}/internal/inject`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ agent_id: "summary-probe", user_id: "111", text: "ciao", surface_in_chat: false }),
    });
    expect(res.status).toBe(202);

    await vi.waitFor(
      async () => {
        const st = await fetch(`${handle?.internalUrl}/internal/status`, {
          headers: { authorization: `Bearer ${SECRET}` },
        });
        const body = (await st.json()) as { inject: { in_flight: number; succeeded: number } };
        expect(body.inject.in_flight).toBe(0);
        expect(body.inject.succeeded).toBe(1);
      },
      { timeout: 8000, interval: 100 },
    );
    // The fixture answers every prompt with the same summary, so each of the
    // three tries an empty turn gets is withheld and captured too, and the
    // person is told the answer is taking longer.
    await vi.waitFor(() => expect(captured).toHaveLength(4), { timeout: 2000, interval: 50 });

    expect(chat).toEqual([pickSlowMessage("ciao")]);
    for (const c of captured) expect(c).toEqual({ agent_id: "summary-probe", summary: SUMMARY });
  });
});

// Every turn carries the organization's clock, from the control-plane's turn
// context. On 6 October no turn on any box carried it: the bridge read its
// bearer from CERASE_INTERNAL_SECRET, which nothing on a box sets, and without
// one it left the call unwired and said nothing. The bearer now comes from
// agents.yaml, where the control-plane writes it.
describe("the clock in front of every turn", () => {
  let handle: RunBridgeHandle | undefined;
  let controlPlane: Server | undefined;

  afterEach(async () => {
    if (handle) await handle.shutdown();
    handle = undefined;
    await new Promise<void>((resolve) => (controlPlane ? controlPlane.close(() => resolve()) : resolve()));
    controlPlane = undefined;
    vi.unstubAllEnvs();
  });

  it("is asked of the control-plane with the bearer agents.yaml carries, and reaches the assistant", async () => {
    const bearers: string[] = [];
    controlPlane = createServer((req, res) => {
      bearers.push(String(req.headers.authorization ?? ""));
      if (req.url?.startsWith("/api/internal/turn-context/clock-probe")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ timezone: "Europe/Rome", now: new Date().toISOString(), last_turn_at: null }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => controlPlane?.listen(0, "127.0.0.1", () => resolve()));
    const cpPort = (controlPlane.address() as AddressInfo).port;

    const SECRET = "inject-secret";
    vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
    vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");
    vi.stubEnv("CERASE_INTERNAL_SECRET", "");
    vi.stubEnv("CERASE_CONTROL_PLANE_URL", `http://127.0.0.1:${cpPort}`);

    const cfg: BridgeConfig = {
      agents: [
        {
          id: "clock-probe",
          channel: "discord",
          cwd: "/home/agent/cerase/workspace",
          mode: "cerase",
          bot_token: "irrelevant",
          allowed_users: ["111"],
          spawn: { command: "env", args: ["--", "FAKE_ECHO_PROMPT=1", "node", FAKE_CHILD] },
        },
      ],
      session: { idle_timeout_minutes: 60, max_concurrent: 16 },
      internal_bearer: "bearer-from-agents-yaml",
    };

    const chat: string[] = [];
    handle = await runBridge({
      config: cfg,
      bridgeE2eTest: false,
      createAdapter: async (agent, dispatcher) => {
        const a = makeFakeAdapter(agent, dispatcher, "ok");
        a.makeSendTarget = () => async (chunk: string) => {
          chat.push(chunk);
          return { ok: true };
        };
        return a;
      },
    });

    const res = await fetch(`${handle.internalUrl}/internal/inject`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ agent_id: "clock-probe", user_id: "111", text: "che ore sono?", surface_in_chat: false }),
    });
    expect(res.status).toBe(202);

    await vi.waitFor(() => expect(chat.join("")).toContain("che ore sono?"), { timeout: 8000, interval: 50 });
    expect(chat.join("")).toMatch(/now=\d{4}-\d{2}-\d{2} \d{2}:\d{2} Europe\/Rome\]/);
    expect(bearers.length).toBeGreaterThan(0);
    expect(new Set(bearers)).toEqual(new Set(["Bearer bearer-from-agents-yaml"]));
  });
});

// The status line a turn shows while a tool runs: the bridge asks the
// control-plane, with the bearer agents.yaml carries, for the sentence of the
// step the assistant is on, and hands it to the channel's status line.
describe("the step a tool is on", () => {
  let handle: RunBridgeHandle | undefined;
  let controlPlane: Server | undefined;

  afterEach(async () => {
    if (handle) await handle.shutdown();
    handle = undefined;
    await new Promise<void>((resolve) => (controlPlane ? controlPlane.close(() => resolve()) : resolve()));
    controlPlane = undefined;
    vi.unstubAllEnvs();
  });

  it("is asked of the control-plane and shown in the turn's status line, which goes when the turn ends", async () => {
    const asked: { url?: string; bearer?: string; body: unknown }[] = [];
    controlPlane = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/internal/tool-step/doc-qa") {
        let body = "";
        req.on("data", (c: Buffer) => {
          body += c.toString("utf8");
        });
        req.on("end", () => {
          asked.push({ url: req.url, bearer: req.headers.authorization, body: JSON.parse(body) });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ sentence: "Sto affidando una parte del lavoro…" }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => controlPlane?.listen(0, "127.0.0.1", () => resolve()));
    const cpPort = (controlPlane.address() as AddressInfo).port;
    vi.stubEnv("CERASE_INTERNAL_SECRET", "");
    vi.stubEnv("CERASE_CONTROL_PLANE_URL", `http://127.0.0.1:${cpPort}`);

    const cfg = makeConfig();
    cfg.internal_bearer = "bearer-from-agents-yaml";
    cfg.agents = [
      {
        ...cfg.agents[0]!,
        spawn: { command: "env", args: ["--", "FAKE_TOOL_CALL_MS=4500", "FAKE_REPLY=Fatto.", "node", FAKE_CHILD] },
      },
    ];
    const chat: string[] = [];
    const status: string[] = [];
    let dispatcher: Dispatcher | undefined;
    handle = await runBridge({
      config: cfg,
      bridgeE2eTest: false,
      createAdapter: async (agent, d) => {
        dispatcher = d;
        const a = makeFakeAdapter(agent, d, "ok");
        a.makeSendTarget = () => async (chunk: string) => {
          chat.push(chunk);
          return { ok: true };
        };
        a.statusLine = () => ({
          show: async (text) => {
            status.push(`show ${text}`);
          },
          close: async () => {
            status.push("close");
          },
        });
        return a;
      },
    });

    expect(await dispatcher?.handleMessage("doc-qa", "111", "mi prepari il riepilogo della settimana?")).toEqual({
      ok: true,
    });
    expect(chat.join("")).toBe("Fatto.");
    await vi.waitFor(() => expect(status).toEqual(["show Sto affidando una parte del lavoro…", "close"]));
    // The fixture's tool starts as `task` and reports no input.
    expect(asked).toEqual([
      {
        url: "/api/internal/tool-step/doc-qa",
        bearer: "Bearer bearer-from-agents-yaml",
        body: { tool: "task", input: {}, lang: "it" },
      },
    ]);
  }, 20_000);
});

// The send path withholds a chunk that is the engine's own summary whole. Its
// title alone is enough there, and the stream's holds, which start at the
// appliance's section headings, let it through to that point.
describe("a reply the send path withholds whole", () => {
  let handle: RunBridgeHandle | undefined;

  afterEach(async () => {
    if (handle) await handle.shutdown();
    handle = undefined;
  });

  it("is not an answer: the turn is asked again, and the person is answered", async () => {
    const DROPPED = "Anchored Summary of the session and the next actions to take";
    const cfg = makeConfig();
    cfg.agents = [
      { ...cfg.agents[0]!, spawn: { command: "env", args: ["--", `FAKE_REPLY=${DROPPED}`, "node", FAKE_CHILD] } },
    ];
    const chat: string[] = [];
    let dispatcher: Dispatcher | undefined;
    handle = await runBridge({
      config: cfg,
      bridgeE2eTest: false,
      createAdapter: async (agent, d) => {
        dispatcher = d;
        const a = makeFakeAdapter(agent, d, "ok");
        a.makeSendTarget = () => async (chunk: string) => {
          chat.push(chunk);
          return { ok: true };
        };
        return a;
      },
    });

    // The fixture answers every prompt with the same summary.
    expect(await dispatcher?.handleMessage("doc-qa", "111", "ciao")).toEqual({ ok: true });
    expect(chat).toEqual([pickSlowMessage("ciao")]);
  });
});

// Google Chat takes an answer as one message; the bridge learns that from the
// agent's adapter, at every turn, and Discord-shaped adapters declare nothing.
describe("the shape of an answer comes from the agent's adapter", () => {
  let handle: RunBridgeHandle | undefined;

  afterEach(async () => {
    if (handle) await handle.shutdown();
    handle = undefined;
    vi.unstubAllEnvs();
  });

  const ANSWER = Array.from(
    { length: 8 },
    (_, i) => `Parte ${i + 1} del riepilogo: ${"la settimana prosegue ".repeat(12).trim()}.`,
  ).join(" ");

  it("an adapter that takes whole answers gets one message, and one that does not gets the streamed pieces", async () => {
    const SECRET = "whole-secret";
    vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
    vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");
    const spawn = { command: "env", args: ["--", `FAKE_REPLY=${ANSWER}`, "FAKE_CHUNKS=40", "node", FAKE_CHILD] };
    const agent = (id: string): AgentConfig => ({
      id,
      channel: "discord",
      cwd: "/home/agent/cerase/workspace",
      mode: "cerase",
      bot_token: "irrelevant",
      allowed_users: ["111"],
      spawn,
    });
    const cfg: BridgeConfig = {
      agents: [agent("whole-probe"), agent("pieces-probe")],
      session: { idle_timeout_minutes: 60, max_concurrent: 16 },
    };

    const chat = new Map<string, string[]>();
    const split = vi.fn((text: string) => [text]);
    handle = await runBridge({
      config: cfg,
      bridgeE2eTest: false,
      createAdapter: async (a, dispatcher) => {
        const fake = makeFakeAdapter(a, dispatcher, "ok");
        chat.set(a.id, []);
        fake.makeSendTarget = () => async (chunk: string) => {
          chat.get(a.id)?.push(chunk);
          return { ok: true };
        };
        if (a.id === "whole-probe") fake.wholeAnswers = { split };
        return fake;
      },
    });

    for (const id of ["whole-probe", "pieces-probe"]) {
      const res = await fetch(`${handle.internalUrl}/internal/inject`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ agent_id: id, user_id: "111", text: "ciao", surface_in_chat: false }),
      });
      expect(res.status).toBe(202);
    }
    await vi.waitFor(
      async () => {
        const st = await fetch(`${handle?.internalUrl}/internal/status`, {
          headers: { authorization: `Bearer ${SECRET}` },
        });
        const body = (await st.json()) as { inject: { in_flight: number; succeeded: number } };
        expect(body.inject.in_flight).toBe(0);
        expect(body.inject.succeeded).toBe(2);
      },
      { timeout: 8000, interval: 100 },
    );

    expect(chat.get("whole-probe")).toEqual([ANSWER]);
    expect(split).toHaveBeenCalledWith(ANSWER);
    const pieces = chat.get("pieces-probe") ?? [];
    expect(pieces.length).toBeGreaterThanOrEqual(8);
    // Whitespace aside: a chunk the child sends late is flushed by the idle
    // timer, which can cut inside a sentence.
    expect(pieces.join("").replace(/\s+/g, "")).toBe(ANSWER.replace(/\s+/g, ""));
  });
});

// The measured case: the container lost its network for five minutes and both
// status surfaces reported the Discord adapter healthy throughout, with
// nothing logged. The adapter recovered on its own, so nothing was broken —
// but an alert wired to `ready` would not have fired. What the bridge
// publishes has to move when the provider stops answering.
describe("a client that believes a dead socket is alive", () => {
  let handle: RunBridgeHandle | undefined;

  afterEach(async () => {
    if (handle) await handle.shutdown();
    handle = undefined;
    vi.unstubAllEnvs();
  });

  const soloConfig = (): BridgeConfig => ({
    agents: [
      {
        id: "solo",
        channel: "discord",
        cwd: "/home/agent/cerase/workspace",
        mode: "cerase",
        bot_token: "tok",
        allowed_users: ["111"],
        spawn: { command: "true", args: [] },
      },
    ],
    session: { idle_timeout_minutes: 60, max_concurrent: 16 },
  });

  const readStatus = async (secret: string) => {
    const res = await fetch(`${handle?.internalUrl}/internal/status`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    return (await res.json()) as {
      agents: Array<{ id: string; ready: boolean | null; lastContactAgeMs?: number | null }>;
    };
  };

  it("reports not-ready, and publishes the age, while the provider is silent", async () => {
    const SECRET = "reachability-secret";
    vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
    vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");

    let ageMs = 1_000;
    const snapshot = () => ({ lastContactAt: 0, ageMs, stale: ageMs > 180_000 });
    const adapter: ChatAdapter = {
      agentId: "solo",
      async start() {},
      async stop() {},
      // The client's own flag never wavered during the outage, so it is held
      // true here and the verdict has to come from the measurement.
      ready: () => isChannelReady(true, snapshot()),
      reachability: snapshot,
      makeSendTarget: () => async () => ({ ok: true }),
    };

    handle = await runBridge({ config: soloConfig(), bridgeE2eTest: false, createAdapter: async () => adapter });

    expect((await readStatus(SECRET)).agents[0]).toMatchObject({ ready: true, lastContactAgeMs: 1_000 });
    expect((await fetch(`${handle.internalUrl}/healthz`)).status).toBe(200);

    ageMs = 5 * 60_000;
    expect((await readStatus(SECRET)).agents[0]).toMatchObject({ ready: false, lastContactAgeMs: 300_000 });
    const health = await fetch(`${handle.internalUrl}/healthz`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ status: "no_chat_transport", ready: 0, readyOf: 1 });
  });

  it("an adapter that measures nothing keeps the older meaning and a null age", async () => {
    // Non-vacuity: the change must not make every channel report an age, and a
    // channel with no probe must not read as unreachable.
    const SECRET = "no-probe-secret";
    vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
    vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");

    const adapter: ChatAdapter = {
      agentId: "solo",
      async start() {},
      async stop() {},
      ready: () => true,
      makeSendTarget: () => async () => ({ ok: true }),
    };

    handle = await runBridge({ config: soloConfig(), bridgeE2eTest: false, createAdapter: async () => adapter });

    expect((await readStatus(SECRET)).agents[0]).toMatchObject({ ready: true, lastContactAgeMs: null });
    expect((await fetch(`${handle.internalUrl}/healthz`)).status).toBe(200);
  });
});

// Google calls the webhook for an assistant's own Chat app. The block that
// named one app for the whole organisation is no longer read, so a file that
// still carries it opens no port nobody's app points at.
describe("an organisation-wide Workspace Chat block, from before every assistant had its own app", () => {
  let handle: RunBridgeHandle | undefined;
  let dir: string;
  let cfgPath: string;

  const yaml = (withApp: boolean) =>
    `${
      withApp
        ? `workspace_chat:
  project_number: "123456789012"
  credentials_path: /var/cerase/workspace-chat-creds/service-account.json
  allowed_domains: [example.com]
`
        : ""
    }agents:
  - id: maintainer-1
    channel: web
    allowed_users: ["maintainer:org-1"]
    spawn: { command: docker, args: [] }
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`;

  async function boot(withApp: boolean, watch: boolean) {
    vi.stubEnv("WORKSPACE_CHAT_PORT", "0");
    dir = mkdtempSync(join(tmpdir(), "bridge-chat-app-"));
    cfgPath = join(dir, "agents.yaml");
    writeFileSync(cfgPath, yaml(withApp));
    handle = await runBridge({
      config: loadConfig(cfgPath, {}),
      bridgeE2eTest: false,
      ...(watch ? { configPath: cfgPath } : {}),
      createAdapter: async (agent, dispatcher) => makeFakeAdapter(agent, dispatcher, "ok"),
    });
  }

  afterEach(async () => {
    if (handle) await handle.shutdown();
    handle = undefined;
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("opens nothing: only an assistant's own app is served", async () => {
    await boot(true, false);
    expect(workspaceChatListenerPort()).toBeUndefined();
  });

  it("a reload that adds only the old block still opens nothing", async () => {
    await boot(false, true);
    writeFileSync(cfgPath, yaml(true));
    await new Promise((r) => setTimeout(r, 1500));
    expect(workspaceChatListenerPort()).toBeUndefined();
  });
});

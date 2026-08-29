import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RunBridgeHandle, runBridge } from "./bridge.js";
import type { ChatAdapter } from "./chat-adapter.js";
import { type AgentConfig, type BridgeConfig, loadConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";
import { isChannelReady } from "./reachability.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

function makeConfig(): BridgeConfig {
  return {
    agents: [
      {
        id: "doc-qa",
        bot_token: "tok-doc",
        allowed_users: ["111"],
        spawn: { command: "env", args: ["--", "FAKE_REPLY=hi", "node", FAKE_CHILD] },
      },
      {
        id: "policy-qa",
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
      agents: [{ id: "solo", bot_token: "tok", allowed_users: ["111"], spawn: { command: "true", args: [] } }],
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
    expect(status.agents[0].ready).toBe(false);
    expect(status.agents[0].failure?.kind).toBe("credential_rejected");
    expect(status.agents[0].failure?.credential).toBe("bot_token");
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
        agents: [{ id: "solo", bot_token: "tok", allowed_users: ["111"], spawn: { command: "true", args: [] } }],
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
    expect(made["doc-qa"].startCalls).toBe(1);
    expect(made["policy-qa"].startCalls).toBe(1);
    expect(handle.internalUrl).toBeDefined();

    // /internal/status is truthful: the failed adapter reports ready:false
    // (not null), the healthy one is present.
    const statusRes = await fetch(`${handle.internalUrl}/internal/status`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as { agents: Array<{ id: string; ready: boolean | null }> };
    expect(status.agents.find((a) => a.id === "doc-qa")?.ready).toBe(false);
    expect(status.agents.find((a) => a.id === "policy-qa")).toBeDefined();

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
    expect(made["doc-qa"].startCalls).toBe(1);

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
    cfg.agents[0].spawn = { command: "env", args: ["--", "FAKE_MODES=build,plan", "node", FAKE_CHILD] };
    cfg.agents[1].spawn = { command: "env", args: ["--", "FAKE_MODES=build,cerase,plan", "node", FAKE_CHILD] };
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
          { id: "web", bot_token: "n/a", allowed_users: ["111"], spawn: { command: "true", args: [] } },
          { id: "discordy", bot_token: "tok", allowed_users: ["111"], spawn: { command: "true", args: [] } },
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
          if (failsLeftById[agentId] > 0) {
            failsLeftById[agentId] -= 1;
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
      expect(made.discordy.startCalls).toBe(1);
      expect(await getReady("discordy")).toBe(false);
      expect(await getReady("web")).toBe(true);

      // Advance past the (jittered) backoff → supervisor retries and recovers.
      await vi.advanceTimersByTimeAsync(5000);
      expect(made.discordy.startCalls).toBe(2);
      expect(await getReady("discordy")).toBe(true);
    } finally {
      vi.useRealTimers();
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
    // Regression test for a bug caught during the M8 manual smoke:
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
    // M-ACP-DISCLOSURE-OFF: no disclaimer precedes the reply — it's just the reply.
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
    agents: [{ id: "solo", bot_token: "tok", allowed_users: ["111"], spawn: { command: "true", args: [] } }],
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

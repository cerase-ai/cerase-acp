import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { runBridge, type RunBridgeHandle } from "./bridge.js";
import type { BridgeConfig } from "./config.js";
import type { AgentConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";
import type { ChatAdapter } from "./chat-adapter.js";

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

  it("production mode: an adapter login failure rejects runBridge", async () => {
    const cfg = makeConfig();
    await expect(
      runBridge({
        config: cfg,
        bridgeE2eTest: false,
        createAdapter: async (agent, dispatcher) => makeFakeAdapter(agent, dispatcher, "fail"),
      }),
    ).rejects.toThrow();
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
    // M-LEGAL-1: the first-contact AI disclosure precedes the reply.
    expect(reply.text).toMatch(/assistente AI|AI assistant/);
    expect(reply.text).toContain("test injection works!");

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

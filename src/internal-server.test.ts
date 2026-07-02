import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { headsUpText, type InternalServer, startInternalServer } from "./internal-server.js";

// Minimal Dispatcher fake — records the calls the endpoint makes.
// M-ACP-FAILLOUD-1: both methods now return a DeliveryResult; an optional
// `outcome` lets a test simulate a failed turn/delivery so we can assert the
// endpoint surfaces it as a 500.
function makeFakeDispatcher(outcome: import("./chat-adapter.js").DeliveryResult = { ok: true }) {
  const calls: { handled: Array<[string, string, string]>; system: Array<[string, string, string]> } = {
    handled: [],
    system: [],
  };
  const dispatcher = {
    async handleMessage(agentId: string, userId: string, text: string) {
      calls.handled.push([agentId, userId, text]);
      return outcome;
    },
    async sendSystemMessage(agentId: string, userId: string, text: string) {
      calls.system.push([agentId, userId, text]);
      return outcome;
    },
  } as unknown as import("./dispatcher.js").Dispatcher;
  return { dispatcher, calls };
}

const SECRET = "test-acp-secret";

describe("internal-server /internal/inject", () => {
  let server: InternalServer;
  let calls: ReturnType<typeof makeFakeDispatcher>["calls"];
  let base: string;

  beforeEach(async () => {
    const fake = makeFakeDispatcher();
    calls = fake.calls;
    server = await startInternalServer({
      dispatcher: fake.dispatcher,
      internalSecret: SECRET,
      port: 0,
      host: "127.0.0.1",
    });
    base = `http://127.0.0.1:${server.port()}`;
  });

  afterEach(async () => {
    await server.close();
  });

  const post = (body: unknown, auth = `Bearer ${SECRET}`) =>
    fetch(`${base}/internal/inject`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify(body),
    });

  it("401s without the shared secret", async () => {
    const resp = await post({ agent_id: "a", user_id: "u", text: "x" }, "Bearer wrong");
    expect(resp.status).toBe(401);
    expect(calls.handled).toHaveLength(0);
  });

  it("400s on an invalid body", async () => {
    const resp = await post({ agent_id: "a" });
    expect(resp.status).toBe(400);
  });

  it("injects the message (202) and posts a heads-up by default", async () => {
    const resp = await post({ agent_id: "a1", user_id: "u1", text: "manda la rassegna" });
    expect(resp.status).toBe(202);
    // M-ACP-INJECT-ACK-1: the turn now runs detached — wait for it.
    await vi.waitFor(() => {
      expect(calls.handled).toEqual([["a1", "u1", "manda la rassegna"]]);
      expect(calls.system).toEqual([["a1", "u1", headsUpText("manda la rassegna")]]);
    });
  });

  it("SCHED-5: headsUpText acks the scheduled message with the body in a code block", () => {
    const t = headsUpText("manda la rassegna");
    expect(t).toContain("Ricevuto messaggio temporizzato");
    expect(t).toContain("```\nmanda la rassegna\n```");
    expect(t).toContain("ora lo prendo in carico");
  });

  it("C1-4: a caller-supplied heads_up overrides the default scheduled wording", async () => {
    const custom = "💬 **Paolo** (dal pannello):\n```\nciao\n```";
    const resp = await post({ agent_id: "a1", user_id: "u1", text: "ciao", heads_up: custom });
    expect(resp.status).toBe(202);
    await vi.waitFor(() => {
      expect(calls.system).toEqual([["a1", "u1", custom]]);
      expect(calls.handled).toEqual([["a1", "u1", "ciao"]]);
    });
  });

  it("C1-4: an empty heads_up falls back to the default scheduled wording", async () => {
    const resp = await post({ agent_id: "a1", user_id: "u1", text: "x", heads_up: "" });
    expect(resp.status).toBe(202);
    await vi.waitFor(() => {
      expect(calls.system).toEqual([["a1", "u1", headsUpText("x")]]);
    });
  });

  it("skips the heads-up when surface_in_chat is false", async () => {
    const resp = await post({ agent_id: "a1", user_id: "u1", text: "x", surface_in_chat: false });
    expect(resp.status).toBe(202);
    // The heads-up (when enabled) is sent BEFORE the turn, so once the turn
    // has run, a missing heads-up is conclusive, not a race.
    await vi.waitFor(() => expect(calls.handled).toHaveLength(1));
    expect(calls.system).toHaveLength(0);
  });

  it("E3: system_message_only delivers the text as a system message and runs NO model turn", async () => {
    const text = "Per usare Gmail collega il tuo account: https://x/connect/tok";
    const resp = await post({ agent_id: "a1", user_id: "u1", text, system_message_only: true });
    expect(resp.status).toBe(202);
    expect(calls.system).toEqual([["a1", "u1", text]]);
    expect(calls.handled).toHaveLength(0);
  });

  it("404s for any other path", async () => {
    const resp = await fetch(`${base}/nope`, { headers: { authorization: `Bearer ${SECRET}` } });
    expect(resp.status).toBe(404);
  });
});

// M-ACP-FAILLOUD-1 (+ M-ACP-INJECT-ACK-1) — failures must never be silent.
// The system-message-only path still reports a truthful 500 (the delivery IS
// the whole operation and is fast). The model-turn path now acks 202 at
// ACCEPTANCE (the caller uses a 15s fire-and-forget timeout; awaiting the
// full turn caused duplicate scheduled DMs), so its failures surface via the
// `inject` block of GET /internal/status + loud logs instead of the HTTP code.
describe("internal-server /internal/inject fail-loud (M-ACP-FAILLOUD-1)", () => {
  let server: InternalServer;
  let base: string;

  const startWith = async (outcome: import("./chat-adapter.js").DeliveryResult) => {
    server = await startInternalServer({
      dispatcher: makeFakeDispatcher(outcome).dispatcher,
      internalSecret: SECRET,
      port: 0,
      host: "127.0.0.1",
    });
    base = `http://127.0.0.1:${server.port()}`;
  };

  afterEach(async () => {
    await server.close();
  });

  const post = (body: unknown) =>
    fetch(`${base}/internal/inject`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(body),
    });

  const getInjectStatus = async () => {
    const resp = await fetch(`${base}/internal/status`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      inject: {
        in_flight: number;
        succeeded: number;
        failed: number;
        last_failure: { agent_id: string; user_id: string; at: string; error: string } | null;
      };
    };
    return body.inject;
  };

  it("M-ACP-INJECT-ACK-1: a failed detached turn still acks 202 but is surfaced in /internal/status", async () => {
    await startWith({ ok: false, error: new Error("turn failed") });
    const resp = await post({ agent_id: "a1", user_id: "u1", text: "x", surface_in_chat: false });
    expect(resp.status).toBe(202); // acceptance, not completion
    await vi.waitFor(async () => {
      const inject = await getInjectStatus();
      expect(inject.failed).toBe(1);
      expect(inject.in_flight).toBe(0);
      expect(inject.last_failure).toMatchObject({
        agent_id: "a1",
        user_id: "u1",
        error: "turn failed",
      });
      expect(inject.last_failure?.at).toBeTruthy();
    });
  });

  it("202s when the dispatcher reports success, and counts it as succeeded", async () => {
    await startWith({ ok: true });
    const resp = await post({ agent_id: "a1", user_id: "u1", text: "x", surface_in_chat: false });
    expect(resp.status).toBe(202);
    await vi.waitFor(async () => {
      const inject = await getInjectStatus();
      expect(inject.succeeded).toBe(1);
      expect(inject.failed).toBe(0);
      expect(inject.last_failure).toBeNull();
    });
  });

  it("500s a system_message_only inject when delivery fails (stays synchronous)", async () => {
    await startWith({ ok: false, error: new Error("channel down") });
    const resp = await post({ agent_id: "a1", user_id: "u1", text: "x", system_message_only: true });
    expect(resp.status).toBe(500);
  });
});

// M-ACP-INJECT-ACK-1 — the 202 must reflect ACCEPTANCE of the inject, not
// completion of the model turn: the control-plane's AcpInjector uses a 15s
// HTTP timeout and treats inject as fire-and-forget, so awaiting the full
// turn made every >15s turn throw ChatInjectFailed client-side while the
// turn actually ran → the scheduled dispatcher re-fired (duplicate DMs) and
// the panel kept the draft. The turn is a logged background task whose
// failures stay observable (M-ACP-FAILLOUD): never a silent 202-then-nothing.
describe("internal-server /internal/inject acks before the turn (M-ACP-INJECT-ACK-1)", () => {
  let server: InternalServer;
  let base: string;

  afterEach(async () => {
    await server.close();
  });

  const start = async (dispatcher: import("./dispatcher.js").Dispatcher) => {
    server = await startInternalServer({
      dispatcher,
      internalSecret: SECRET,
      port: 0,
      host: "127.0.0.1",
    });
    base = `http://127.0.0.1:${server.port()}`;
  };

  const post = (body: unknown) =>
    fetch(`${base}/internal/inject`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(body),
    });

  const getInjectStatus = async () => {
    const resp = await fetch(`${base}/internal/status`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    const body = (await resp.json()) as {
      inject: { in_flight: number; succeeded: number; failed: number; last_failure: unknown };
    };
    return body.inject;
  };

  it("returns 202 while the turn is still running (a >15s turn can no longer time the caller out)", async () => {
    // A turn that only completes when the test releases it — simulating the
    // long model turn that used to outlive the caller's 15s timeout.
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let turnStarted = false;
    let turnResolved = false;
    const events: string[] = [];
    const dispatcher = {
      async handleMessage() {
        turnStarted = true;
        events.push("turn");
        await turnGate;
        turnResolved = true;
        return { ok: true as const };
      },
      async sendSystemMessage() {
        events.push("heads-up");
        return { ok: true as const };
      },
    } as unknown as import("./dispatcher.js").Dispatcher;
    await start(dispatcher);

    const resp = await post({ agent_id: "a1", user_id: "u1", text: "rassegna" });
    // The ack arrived while the turn is still pending.
    expect(resp.status).toBe(202);
    expect(await resp.json()).toEqual({ status: "accepted" });
    expect(turnResolved).toBe(false);

    // The detached task is tracked as in-flight, and the heads-up still
    // precedes the turn inside it.
    await vi.waitFor(async () => {
      expect(turnStarted).toBe(true);
      expect((await getInjectStatus()).in_flight).toBe(1);
    });
    expect(events).toEqual(["heads-up", "turn"]);

    releaseTurn();
    await vi.waitFor(async () => {
      const inject = await getInjectStatus();
      expect(inject.in_flight).toBe(0);
      expect(inject.succeeded).toBe(1);
    });
  });

  it("a dispatcher that THROWS in the detached turn is caught (no unhandled rejection) and surfaced", async () => {
    const dispatcher = {
      async handleMessage() {
        throw new Error("opencode exploded");
      },
      async sendSystemMessage() {
        return { ok: true as const };
      },
    } as unknown as import("./dispatcher.js").Dispatcher;
    await start(dispatcher);

    const resp = await post({ agent_id: "a1", user_id: "u1", text: "x", surface_in_chat: false });
    expect(resp.status).toBe(202);
    await vi.waitFor(async () => {
      const inject = await getInjectStatus();
      expect(inject.failed).toBe(1);
      expect(inject.in_flight).toBe(0);
      expect(inject.last_failure).toMatchObject({ agent_id: "a1", error: "opencode exploded" });
    });
  });

  it("a failed heads-up stays best-effort: the turn still runs and the inject can still succeed", async () => {
    const handled: string[] = [];
    const dispatcher = {
      async handleMessage(_a: string, _u: string, text: string) {
        handled.push(text);
        return { ok: true as const };
      },
      async sendSystemMessage() {
        throw new Error("channel hiccup");
      },
    } as unknown as import("./dispatcher.js").Dispatcher;
    await start(dispatcher);

    const resp = await post({ agent_id: "a1", user_id: "u1", text: "vai" });
    expect(resp.status).toBe(202);
    await vi.waitFor(async () => {
      expect(handled).toEqual(["vai"]);
      expect((await getInjectStatus()).succeeded).toBe(1);
    });
  });
});

// M-BRIDGE-LIVENESS-1 — GET /internal/status surfaces the REAL per-agent
// runtime liveness (attached + client-ready) so the control-plane can show
// "Attivo ma disconnesso" instead of a green badge over a down bridge.
describe("internal-server /internal/status", () => {
  let server: InternalServer;
  let base: string;
  const liveAgents = [
    { id: "agent-1", channel: "discord", attached: true, ready: true },
    { id: "agent-2", channel: "telegram", attached: true, ready: false },
  ];

  beforeEach(async () => {
    const fake = makeFakeDispatcher();
    server = await startInternalServer({
      dispatcher: fake.dispatcher,
      internalSecret: SECRET,
      port: 0,
      host: "127.0.0.1",
      getAgentStatus: () => liveAgents,
    });
    base = `http://127.0.0.1:${server.port()}`;
  });

  afterEach(async () => {
    await server.close();
  });

  const getStatus = (auth = `Bearer ${SECRET}`) =>
    fetch(`${base}/internal/status`, { headers: { authorization: auth } });

  it("401s without the shared secret", async () => {
    const resp = await getStatus("Bearer wrong");
    expect(resp.status).toBe(401);
  });

  it("returns the per-agent liveness reported by getAgentStatus", async () => {
    const resp = await getStatus();
    expect(resp.status).toBe(200);
    // M-ACP-INJECT-ACK-1: the payload also carries the additive `inject`
    // block (detached-turn observability) — zeroed when nothing ran.
    expect(await resp.json()).toEqual({
      agents: liveAgents,
      inject: { in_flight: 0, succeeded: 0, failed: 0, last_failure: null },
    });
  });

  it("reports an empty set when no agent is attached (the agents.yaml-blanked incident)", async () => {
    const empty = await startInternalServer({
      dispatcher: makeFakeDispatcher().dispatcher,
      internalSecret: SECRET,
      port: 0,
      host: "127.0.0.1",
      getAgentStatus: () => [],
    });
    try {
      const resp = await fetch(`http://127.0.0.1:${empty.port()}/internal/status`, {
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toMatchObject({ agents: [] });
    } finally {
      await empty.close();
    }
  });

  it("defaults to an empty set when no status provider is wired", async () => {
    const noProvider = await startInternalServer({
      dispatcher: makeFakeDispatcher().dispatcher,
      internalSecret: SECRET,
      port: 0,
      host: "127.0.0.1",
    });
    try {
      const resp = await fetch(`http://127.0.0.1:${noProvider.port()}/internal/status`, {
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toMatchObject({ agents: [] });
    } finally {
      await noProvider.close();
    }
  });
});

// M-ACP-HEALTHCHECK-1 — an UNAUTHENTICATED liveness probe so the compose
// healthcheck can tell the bridge is actually serving (the old `node --version`
// healthcheck stayed green all through the crash-loop). It must not weaken the
// shared-secret gate on the other routes.
describe("internal-server /healthz (M-ACP-HEALTHCHECK-1)", () => {
  let server: InternalServer;
  let base: string;

  beforeEach(async () => {
    const fake = makeFakeDispatcher();
    server = await startInternalServer({
      dispatcher: fake.dispatcher,
      internalSecret: SECRET,
      port: 0,
      host: "127.0.0.1",
      getAgentStatus: () => [
        { id: "a", channel: "web", attached: true, ready: true },
        { id: "b", channel: "discord", attached: true, ready: false },
      ],
    });
    base = `http://127.0.0.1:${server.port()}`;
  });

  afterEach(async () => {
    await server.close();
  });

  it("GET /healthz → 200 {status:'ok'} with NO Authorization header", async () => {
    const resp = await fetch(`${base}/healthz`); // deliberately no bearer
    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({ status: "ok" });
  });

  it("reports adapter + ready counts (no identities/secrets) when a status provider is wired", async () => {
    const resp = await fetch(`${base}/healthz`);
    const body = (await resp.json()) as { status: string; adapters?: number; ready?: number };
    expect(body.adapters).toBe(2);
    expect(body.ready).toBe(1);
  });

  it("does NOT weaken the secret gate — /internal/inject + /internal/status still 401 without the bearer", async () => {
    const inject = await fetch(`${base}/internal/inject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "a", user_id: "u", text: "x" }),
    });
    expect(inject.status).toBe(401);
    const status = await fetch(`${base}/internal/status`);
    expect(status.status).toBe(401);
  });
});

// M-ACP-HARDEN-1 — the inject endpoint must not deliver text to an arbitrary
// user on an arbitrary agent's channel even with the internal secret: it is
// now gated on the agent's allowlist, on BOTH the model-turn and the
// system-message-only paths, before any send.
describe("internal-server /internal/inject allowlist (M-ACP-HARDEN-1)", () => {
  let server: InternalServer;
  let calls: ReturnType<typeof makeFakeDispatcher>["calls"];
  let base: string;

  // Only ("a1","ok") is allowed; everything else is rejected.
  const isAllowed = (agentId: string, userId: string) => agentId === "a1" && userId === "ok";

  beforeEach(async () => {
    const fake = makeFakeDispatcher();
    calls = fake.calls;
    server = await startInternalServer({
      dispatcher: fake.dispatcher,
      internalSecret: SECRET,
      port: 0,
      host: "127.0.0.1",
      isAllowed,
    });
    base = `http://127.0.0.1:${server.port()}`;
  });

  afterEach(async () => {
    await server.close();
  });

  const post = (body: unknown) =>
    fetch(`${base}/internal/inject`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(body),
    });

  it("403s a normal inject to a non-allowed user — no heads-up, no model turn", async () => {
    const resp = await post({ agent_id: "a1", user_id: "intruder", text: "leak" });
    expect(resp.status).toBe(403);
    expect(calls.handled).toHaveLength(0);
    expect(calls.system).toHaveLength(0);
  });

  it("403s a system_message_only inject to a non-allowed user — no send", async () => {
    const resp = await post({ agent_id: "a1", user_id: "intruder", text: "leak", system_message_only: true });
    expect(resp.status).toBe(403);
    expect(calls.system).toHaveLength(0);
  });

  it("403s an inject to an unknown agent", async () => {
    const resp = await post({ agent_id: "ghost", user_id: "ok", text: "x" });
    expect(resp.status).toBe(403);
    expect(calls.handled).toHaveLength(0);
  });

  it("still injects (202) for an allowed (agent,user)", async () => {
    const resp = await post({ agent_id: "a1", user_id: "ok", text: "ciao" });
    expect(resp.status).toBe(202);
    expect(calls.handled).toEqual([["a1", "ok", "ciao"]]);
  });
});

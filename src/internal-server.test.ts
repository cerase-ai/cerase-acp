import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { headsUpText, type InternalServer, startInternalServer } from "./internal-server.js";

// Minimal Dispatcher fake — records the calls the endpoint makes.
function makeFakeDispatcher() {
  const calls: { handled: Array<[string, string, string]>; system: Array<[string, string, string]> } = {
    handled: [],
    system: [],
  };
  const dispatcher = {
    async handleMessage(agentId: string, userId: string, text: string) {
      calls.handled.push([agentId, userId, text]);
    },
    async sendSystemMessage(agentId: string, userId: string, text: string) {
      calls.system.push([agentId, userId, text]);
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
    expect(calls.handled).toEqual([["a1", "u1", "manda la rassegna"]]);
    expect(calls.system).toEqual([["a1", "u1", headsUpText("manda la rassegna")]]);
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
    expect(calls.system).toEqual([["a1", "u1", custom]]);
    expect(calls.handled).toEqual([["a1", "u1", "ciao"]]);
  });

  it("C1-4: an empty heads_up falls back to the default scheduled wording", async () => {
    const resp = await post({ agent_id: "a1", user_id: "u1", text: "x", heads_up: "" });
    expect(resp.status).toBe(202);
    expect(calls.system).toEqual([["a1", "u1", headsUpText("x")]]);
  });

  it("skips the heads-up when surface_in_chat is false", async () => {
    const resp = await post({ agent_id: "a1", user_id: "u1", text: "x", surface_in_chat: false });
    expect(resp.status).toBe(202);
    expect(calls.system).toHaveLength(0);
    expect(calls.handled).toHaveLength(1);
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
    expect(await resp.json()).toEqual({ agents: liveAgents });
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
      expect(await resp.json()).toEqual({ agents: [] });
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
      expect(await resp.json()).toEqual({ agents: [] });
    } finally {
      await noProvider.close();
    }
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

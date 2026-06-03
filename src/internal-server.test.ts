import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startInternalServer, headsUpText, type InternalServer } from "./internal-server.js";

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
    server = await startInternalServer({ dispatcher: fake.dispatcher, internalSecret: SECRET, port: 0, host: "127.0.0.1" });
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

  it("skips the heads-up when surface_in_chat is false", async () => {
    const resp = await post({ agent_id: "a1", user_id: "u1", text: "x", surface_in_chat: false });
    expect(resp.status).toBe(202);
    expect(calls.system).toHaveLength(0);
    expect(calls.handled).toHaveLength(1);
  });

  it("404s for any other path", async () => {
    const resp = await fetch(`${base}/nope`, { headers: { authorization: `Bearer ${SECRET}` } });
    expect(resp.status).toBe(404);
  });
});

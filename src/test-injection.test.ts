import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import {
  startTestInjectionServer,
  type TestInjectionServer,
} from "./test-injection.js";
import { Dispatcher } from "./dispatcher.js";
import { SessionManager } from "./session-manager.js";
import { TurnMetaTracker } from "./turn-meta.js";
import type { BridgeConfig } from "./config.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

function makeConfig(reply: string): BridgeConfig {
  return {
    agents: [
      {
        id: "doc-qa",
        bot_token: "irrelevant",
        allowed_users: ["111"],
        spawn: { command: "env", args: ["--", `FAKE_REPLY=${reply}`, "node", FAKE_CHILD] },
      },
    ],
    session: { idle_timeout_minutes: 60, max_concurrent: 16 },
  };
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep as text */
  }
  return { status: res.status, body };
}

describe("test-injection server", () => {
  let server: TestInjectionServer | undefined;
  let mgr: SessionManager | undefined;

  afterEach(async () => {
    if (server) await server.close();
    if (mgr) await mgr.shutdown();
    server = undefined;
    mgr = undefined;
  });

  it("accepts POST /_test/inject and routes through the dispatcher", async () => {
    const cfg = makeConfig("salve, è un test");
    mgr = new SessionManager(cfg);
    const d = new Dispatcher({
      config: cfg,
      sessionManager: mgr,
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: (agentId, userId) => async (text) => {
        server!.recordReply(agentId, userId, text);
      },
    });
    server = await startTestInjectionServer({ dispatcher: d, port: 0 });
    const url = server.url();
    const inject = await fetchJson(`${url}/_test/inject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "doc-qa", user_id: "111", text: "hi" }),
    });
    expect(inject.status).toBe(202);
    const reply = await fetchJson(`${url}/_test/last-reply?agent_id=doc-qa&user_id=111`);
    expect(reply.status).toBe(200);
    expect((reply.body as { text: string }).text).toBe("salve, è un test");
  });

  it("returns 404 from /_test/last-reply when no reply has been recorded yet", async () => {
    const cfg = makeConfig("x");
    mgr = new SessionManager(cfg);
    const d = new Dispatcher({
      config: cfg,
      sessionManager: mgr,
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: () => async () => {},
    });
    server = await startTestInjectionServer({ dispatcher: d, port: 0 });
    const res = await fetchJson(`${server.url()}/_test/last-reply?agent_id=doc-qa&user_id=any`);
    expect(res.status).toBe(404);
  });

  it("returns 400 on POST /_test/inject when required fields are missing", async () => {
    const cfg = makeConfig("x");
    mgr = new SessionManager(cfg);
    const d = new Dispatcher({
      config: cfg,
      sessionManager: mgr,
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: () => async () => {},
    });
    server = await startTestInjectionServer({ dispatcher: d, port: 0 });
    const res = await fetchJson(`${server.url()}/_test/inject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: "111" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown paths", async () => {
    const cfg = makeConfig("x");
    mgr = new SessionManager(cfg);
    const d = new Dispatcher({
      config: cfg,
      sessionManager: mgr,
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: () => async () => {},
    });
    server = await startTestInjectionServer({ dispatcher: d, port: 0 });
    const res = await fetchJson(`${server.url()}/nope`);
    expect(res.status).toBe(404);
  });
});

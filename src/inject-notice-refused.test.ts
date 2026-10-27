// What the inject endpoint answers for a notice it could not deliver: a person
// the bot shares no server with is a refusal that stands until somebody adds
// the bot to a server, a chat client still logging in is a condition that
// passes, and any other failure stays a 500. The endpoint alone is driven
// here, with the delivery result given to it and its log lines captured.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logs = vi.hoisted(() => [] as { name: string; level: string; fields: Record<string, unknown>; msg: string }[]);
vi.mock("./logger.js", () => ({
  makeLogger: (name: string) => {
    const at =
      (level: string) =>
      (fields: Record<string, unknown> = {}, msg = "") =>
        logs.push({ name, level, fields, msg });
    return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"), fatal: at("fatal") };
  },
}));

import type { DeliveryResult } from "./chat-adapter.js";
import { type InternalServer, startInternalServer } from "./internal-server.js";

const SECRET = "inject-notice-refused-secret";
const AGENT = "agent-4";
const USER = "310000000000000444";

function makeFakeDispatcher(outcome: DeliveryResult) {
  const calls: { notices: Array<[string, string, unknown]> } = { notices: [] };
  const dispatcher = {
    async sendNotice(agentId: string, userId: string, notice: unknown) {
      calls.notices.push([agentId, userId, notice]);
      return outcome;
    },
    async sendSystemMessage() {
      return { ok: true as const };
    },
  } as unknown as import("./dispatcher.js").Dispatcher;
  return { dispatcher, calls };
}

const NOTICE = {
  title: "Collega il tuo account",
  body: "«Nadia» può usare Gmail quando colleghi il tuo account.",
  link: { url: "https://example.test/c/abc", label: "Collega Gmail" },
};

const BODY = {
  agent_id: AGENT,
  user_id: USER,
  text: "Collega il tuo account",
  system_message_only: true,
  notice: NOTICE,
};

describe("internal-server /internal/inject: a refused platform notice", () => {
  let server: InternalServer;
  let base: string;

  beforeEach(() => {
    logs.length = 0;
  });

  afterEach(async () => {
    await server.close();
  });

  const startWith = async (outcome: DeliveryResult): Promise<void> => {
    const fake = makeFakeDispatcher(outcome);
    server = await startInternalServer({
      dispatcher: fake.dispatcher,
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

  it("a notice Discord refuses with 50278 answers 409 no_shared_server, and never 500", async () => {
    await startWith({
      ok: false,
      error: Object.assign(new Error("Cannot send messages to this user"), { code: 50278, status: 400 }),
    });

    const resp = await post(BODY);

    expect(resp.status).toBe(409);
    const body = (await resp.json()) as { error: string; detail: string };
    expect(body.error).toBe("no_shared_server");
    expect(typeof body.detail).toBe("string");
    expect(body.detail.trim().length).toBeGreaterThan(0);

    const warns = logs.filter((line) => line.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.fields).toMatchObject({ failure: "no_shared_server", agentId: AGENT, userId: USER });
    expect(logs.filter((line) => line.level === "error")).toHaveLength(0);
  });

  it("a notice whose chat client has not logged in answers 503 channel_not_ready, and never 500", async () => {
    await startWith({
      ok: false,
      error: Object.assign(new Error("the Discord client has not logged in yet"), { code: "channel_not_ready" }),
    });

    const resp = await post(BODY);

    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { error: string; detail: string };
    expect(body.error).toBe("channel_not_ready");
    expect(typeof body.detail).toBe("string");
    expect(body.detail.trim().length).toBeGreaterThan(0);

    const warns = logs.filter((line) => line.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.fields).toMatchObject({ failure: "channel_not_ready", agentId: AGENT, userId: USER });
    expect(logs.filter((line) => line.level === "error")).toHaveLength(0);
  });

  it("a 50278 that is not a number is not read as no_shared_server", async () => {
    await startWith({
      ok: false,
      error: Object.assign(new Error("Cannot send messages to this user"), { code: "50278", status: 400 }),
    });

    const resp = await post(BODY);

    expect(resp.status).toBe(500);
  });
});

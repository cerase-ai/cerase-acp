// The bridge applies agents.yaml as it changes on disk. Each test boots
// runBridge on a real file, rewrites the file, and reads what the bridge did
// through the adapters it created.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunBridgeHandle, runBridge } from "./bridge.js";
import type { ChatAdapter } from "./chat-adapter.js";
import { type AgentConfig, loadConfig } from "./config.js";
import { type Dispatcher, pickRefusalMessage } from "./dispatcher.js";

let dir: string;
let path: string;
let handle: RunBridgeHandle | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-live-reload-"));
  path = join(dir, "agents.yaml");
  vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", "");
});

afterEach(async () => {
  await handle?.shutdown();
  handle = undefined;
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const yaml = (token: string) => `
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

/** An adapter that records its life in `events`, named by the token it was made with. */
function recorder(events: string[], startOf: (token: string) => Promise<void> = async () => {}) {
  return async (agent: AgentConfig): Promise<ChatAdapter> => {
    const token = agent.bot_token ?? "";
    events.push(`create ${token}`);
    return {
      agentId: agent.id,
      async start() {
        events.push(`start ${token}`);
        await startOf(token);
        events.push(`started ${token}`);
      },
      async stop() {
        events.push(`stop ${token}`);
      },
      makeSendTarget: () => async () => ({ ok: true }),
    };
  };
}

describe("a reload that arrives while another is being applied", () => {
  it("is applied after it, against the configuration it left", async () => {
    writeFileSync(path, yaml("tok-1"));
    const events: string[] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    handle = await runBridge({
      config: loadConfig(path, process.env),
      bridgeE2eTest: false,
      configPath: path,
      createAdapter: recorder(events, (token) => (token === "tok-2" ? held : Promise.resolve())),
    });

    writeFileSync(path, yaml("tok-2"));
    await vi.waitFor(() => expect(events).toContain("start tok-2"), { timeout: 5_000, interval: 10 });
    writeFileSync(path, yaml("tok-3"));
    // Long past the reloader's 50 ms debounce, so the second file has been read.
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await vi.waitFor(() => expect(events).toContain("started tok-3"), { timeout: 5_000, interval: 10 });

    expect(events).toEqual([
      "create tok-1",
      "start tok-1",
      "started tok-1",
      "stop tok-1",
      "create tok-2",
      "start tok-2",
      "started tok-2",
      "stop tok-2",
      "create tok-3",
      "start tok-3",
      "started tok-3",
    ]);
  });

  it("is waited for by a stop, which then stops the adapter it started", async () => {
    writeFileSync(path, yaml("tok-1"));
    const events: string[] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    handle = await runBridge({
      config: loadConfig(path, process.env),
      bridgeE2eTest: false,
      configPath: path,
      createAdapter: recorder(events, (token) => (token === "tok-2" ? held : Promise.resolve())),
    });

    writeFileSync(path, yaml("tok-2"));
    await vi.waitFor(() => expect(events).toContain("start tok-2"), { timeout: 5_000, interval: 10 });
    const stopped = handle.shutdown();
    handle = undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await stopped;

    expect(events.slice(-2)).toEqual(["started tok-2", "stop tok-2"]);
  });
});

describe("a reload that changes what a running adapter cannot take", () => {
  it("starts the agent again on its new channel", async () => {
    writeFileSync(path, yaml("tok-1"));
    const made: string[] = [];
    handle = await runBridge({
      config: loadConfig(path, process.env),
      bridgeE2eTest: false,
      configPath: path,
      createAdapter: async (agent) => {
        made.push(agent.channel);
        return {
          agentId: agent.id,
          async start() {},
          async stop() {},
          makeSendTarget: () => async () => ({ ok: true }),
        };
      },
    });

    writeFileSync(path, yaml("tok-1").replace("  - id: solo\n", "  - id: solo\n    channel: telegram\n"));

    await vi.waitFor(() => expect(made).toEqual(["discord", "telegram"]), { timeout: 5_000, interval: 10 });
  });
});

describe("a reload that changes the organisation's language", () => {
  it("writes the bridge's next notice in the new language", async () => {
    const withLocale = (locale: string) => `${yaml("tok-1")}locale: ${locale}\n`;
    writeFileSync(path, withLocale("en"));
    const sent: string[] = [];
    let dispatcher: Dispatcher | undefined;
    handle = await runBridge({
      config: loadConfig(path, process.env),
      bridgeE2eTest: false,
      configPath: path,
      createAdapter: async (agent, d) => {
        dispatcher = d;
        return {
          agentId: agent.id,
          async start() {},
          async stop() {},
          makeSendTarget: () => async (chunk) => {
            sent.push(chunk);
            return { ok: true };
          },
        };
      },
    });
    // A user nobody allowed, writing too little to tell the language: the
    // refusal is in the organisation's.
    await dispatcher?.handleMessage("solo", "999", "ok");
    expect(sent).toEqual([pickRefusalMessage("I'm here, please")]);

    writeFileSync(path, withLocale("fr"));
    await vi.waitFor(
      async () => {
        sent.length = 0;
        await dispatcher?.handleMessage("solo", "999", "ok");
        expect(sent).toEqual([pickRefusalMessage("je suis là, merci pour le document")]);
      },
      { timeout: 5_000, interval: 25 },
    );
  });
});

// The way back from a refused credential. The refusal is fixed outside
// agents.yaml (a switch in the Discord developer portal), so the console's
// «Ripristina connessione» regenerates a file with the same content: the
// control-plane then rewrites nothing and only chmods it, which the watcher
// reports all the same. A reload whose diff is empty starts again every agent
// held as refused, and nothing else.
describe("a reload that changes nothing", () => {
  const SECRET = "reload-refused-secret";
  const PORTAL_SENTENCE =
    "The Discord application behind this bot token is not granted the Message Content intent. Enable it in the developer portal, under Bot and then Privileged Gateway Intents.";

  const twoAgents = `
agents:
  - id: refused
    bot_token: tok-refused
    allowed_users: ["111"]
    spawn:
      command: "true"
      args: []
  - id: healthy
    bot_token: tok-healthy
    allowed_users: ["222"]
    spawn:
      command: "true"
      args: []
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`;

  interface Scripted extends ChatAdapter {
    startCalls: number;
  }

  /** `refused` throws what `failure()` returns, when it returns something; `healthy` always starts. */
  async function boot(failure: () => Error | undefined): Promise<Record<string, Scripted>> {
    vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
    vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");
    // Short enough that a retry loop would fire several times inside a wait.
    vi.stubEnv("CERASE_ACP_ADAPTER_RETRY_BASE_MS", "20");
    vi.stubEnv("CERASE_ACP_ADAPTER_RETRY_MAX_MS", "20");
    writeFileSync(path, twoAgents);
    const made: Record<string, Scripted> = {};
    handle = await runBridge({
      config: loadConfig(path, process.env),
      bridgeE2eTest: false,
      configPath: path,
      createAdapter: async (agent) => {
        let live = false;
        const adapter: Scripted = {
          agentId: agent.id,
          startCalls: 0,
          async start() {
            adapter.startCalls += 1;
            const err = agent.id === "refused" ? failure() : undefined;
            if (err) throw err;
            live = true;
          },
          async stop() {
            live = false;
          },
          ready: () => live,
          makeSendTarget: () => async () => ({ ok: true }),
        };
        made[agent.id] = adapter;
        return adapter;
      },
    });
    return made;
  }

  async function statusOf(agentId: string) {
    const res = await fetch(`${handle?.internalUrl}/internal/status`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    const body = (await res.json()) as {
      agents: Array<{ id: string; ready: boolean | null; failure?: Record<string, unknown> }>;
    };
    return body.agents.find((a) => a.id === agentId);
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

  it("starts again an agent whose refusal is gone, which then reports ready with no failure", async () => {
    let refusing = true;
    const made = await boot(() => (refusing ? new Error("Used disallowed intents") : undefined));
    await settle();
    expect(made.refused?.startCalls).toBe(1);
    expect((await statusOf("refused"))?.failure).toMatchObject({ code: "DisallowedIntents" });

    refusing = false;
    // What the console's regeneration does to a file whose content it would not change.
    chmodSync(path, 0o640);

    await vi.waitFor(() => expect(made.refused?.startCalls).toBe(2), { timeout: 5_000, interval: 10 });
    await vi.waitFor(async () => {
      const refused = await statusOf("refused");
      expect(refused?.ready).toBe(true);
      expect(refused?.failure).toBeUndefined();
    });
    // The healthy agent was left alone.
    expect(made.healthy?.startCalls).toBe(1);
  });

  it("reports a refusal that still holds again, with its sentence, and does not retry it", async () => {
    const made = await boot(() => new Error("Used disallowed intents"));
    await settle();
    expect(made.refused?.startCalls).toBe(1);

    writeFileSync(path, twoAgents);

    await vi.waitFor(() => expect(made.refused?.startCalls).toBe(2), { timeout: 5_000, interval: 10 });
    await settle();
    expect(made.refused?.startCalls).toBe(2);
    const refused = await statusOf("refused");
    expect(refused?.ready).toBe(false);
    expect(refused?.failure).toEqual({
      kind: "credential_rejected",
      code: "DisallowedIntents",
      credential: "bot_token",
      detail: PORTAL_SENTENCE,
    });
    expect(made.healthy?.startCalls).toBe(1);
  });

  // Refused on a retry rather than at boot, so it is the supervisor that holds
  // the refusal, and its record is what would keep the retries from re-arming.
  it("hands a start that now fails for a reason that can pass to the retries", async () => {
    const transient = new Error("Connect Timeout Error");
    let calls = 0;
    let afterReload = false;
    const made = await boot(() => {
      calls += 1;
      if (afterReload) return transient;
      return calls === 1 ? transient : new Error("Used disallowed intents");
    });
    await vi.waitFor(() => expect(made.refused?.startCalls).toBe(2), { timeout: 5_000, interval: 10 });
    await settle();
    expect(made.refused?.startCalls).toBe(2);
    expect((await statusOf("refused"))?.failure).toMatchObject({ code: "DisallowedIntents" });

    afterReload = true;
    chmodSync(path, 0o640);

    // The restart, then at least one retry behind it.
    await vi.waitFor(() => expect(made.refused?.startCalls).toBeGreaterThanOrEqual(4), {
      timeout: 5_000,
      interval: 10,
    });
    expect((await statusOf("refused"))?.failure).toBeUndefined();
  });
});

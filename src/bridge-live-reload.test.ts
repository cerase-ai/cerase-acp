// The bridge applies agents.yaml as it changes on disk. Each test boots
// runBridge on a real file, rewrites the file, and reads what the bridge did
// through the adapters it created.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

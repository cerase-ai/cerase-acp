// A reply the channel cannot carry is kept and sent once the channel is back.
//
// Each test boots the production bridge on a real agents.yaml, with a real ACP
// child, and drives the person's message through the internal server, the way
// the control-plane's notes arrive. Only the chat transport is scripted: it
// refuses what it is handed while it is down, with the error a discord.js
// client gives once its login has failed, and records what reaches the person.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunBridgeHandle, runBridge } from "./bridge.js";
import type { ChatAdapter, DeliveryResult } from "./chat-adapter.js";
import { loadConfig } from "./config.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));
const SECRET = "kept-reply-secret";
const REPLY = "Ho visto la nota: la proposta è approvata e la mando al cliente.";
const HEADS_UP = "Nota dalla piattaforma: la proposta è stata approvata.";
const REFUSED = "Expected token to be set for this request";

let dir: string;
let path: string;
let handle: RunBridgeHandle | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-kept-reply-"));
  path = join(dir, "agents.yaml");
  vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
  vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");
  vi.stubEnv("CERASE_ACP_KEPT_REPLY_POLL_MS", "50");
});

afterEach(async () => {
  await handle?.shutdown();
  handle = undefined;
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const yaml = `
agents:
  - id: vittorio
    bot_token: tok-vittorio
    allowed_users: ["111"]
    spawn:
      command: env
      args: ["--", "FAKE_REPLY=${REPLY}", "node", "${FAKE_CHILD}"]
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`;

/** The channel: down or up as the test says, refusing every send while it is down. */
interface Channel {
  /** What reached the person, in order. */
  delivered: string[];
  /** Sends the channel refused. */
  refused: number;
  /** Whether a login succeeds, and whether the client then reports itself ready. */
  loginWorks: boolean;
  up: boolean;
  /** Refuse every send even while up: a message the channel itself will not take. */
  refuseWhileUp: boolean;
}

async function boot(channel: Channel): Promise<void> {
  writeFileSync(path, yaml);
  handle = await runBridge({
    config: loadConfig(path, process.env),
    bridgeE2eTest: false,
    configPath: path,
    createAdapter: async (agent) => {
      const adapter: ChatAdapter = {
        agentId: agent.id,
        async start() {
          // A login the provider refuses leaves a client with no token, which
          // is what every later send is then refused for.
          if (!channel.loginWorks) {
            channel.up = false;
            throw new Error("Used disallowed intents");
          }
          channel.up = true;
        },
        async stop() {
          channel.up = false;
        },
        ready: () => channel.up,
        makeSendTarget:
          () =>
          async (chunk: string): Promise<DeliveryResult> => {
            if (!channel.up || channel.refuseWhileUp) {
              channel.refused += 1;
              return { ok: false, error: new Error(channel.up ? "Invalid Form Body" : REFUSED) };
            }
            channel.delivered.push(chunk);
            return { ok: true };
          },
      };
      return adapter;
    },
  });
}

async function inject(surfaceInChat: boolean): Promise<void> {
  const res = await fetch(`${handle?.internalUrl}/internal/inject`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      agent_id: "vittorio",
      user_id: "111",
      text: "La proposta è stata approvata.",
      surface_in_chat: surfaceInChat,
      heads_up: HEADS_UP,
    }),
  });
  expect(res.status).toBe(202);
}

async function injects(): Promise<{ in_flight: number; succeeded: number; failed: number }> {
  const res = await fetch(`${handle?.internalUrl}/internal/status`, { headers: { authorization: `Bearer ${SECRET}` } });
  return ((await res.json()) as { inject: { in_flight: number; succeeded: number; failed: number } }).inject;
}

const turnEnded = () =>
  vi.waitFor(
    async () => {
      const s = await injects();
      expect(s.in_flight).toBe(0);
      expect(s.succeeded + s.failed).toBe(1);
    },
    { timeout: 15_000, interval: 50 },
  );

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a reply the channel cannot carry", { timeout: 40_000 }, () => {
  it("is kept while the provider refuses the bot, and sent once, after the heads-up, when the connection is restored", async () => {
    const channel: Channel = { delivered: [], refused: 0, loginWorks: false, up: false, refuseWhileUp: false };
    await boot(channel);
    await inject(true);
    await turnEnded();
    await settle();
    expect(channel.delivered).toEqual([]);

    // «Ripristina connessione» once the switch is on in the provider's portal:
    // the console regenerates agents.yaml with the same content.
    channel.loginWorks = true;
    chmodSync(path, 0o640);

    await vi.waitFor(() => expect(channel.delivered).toEqual([HEADS_UP, REPLY]), { timeout: 10_000, interval: 25 });
    await settle();
    expect(channel.delivered).toEqual([HEADS_UP, REPLY]);
  });

  it("is kept while the client reports itself disconnected, and sent once it reports connected, with no restart", async () => {
    const channel: Channel = { delivered: [], refused: 0, loginWorks: true, up: false, refuseWhileUp: false };
    await boot(channel);
    channel.up = false;
    await inject(false);
    await turnEnded();
    await settle();
    expect(channel.delivered).toEqual([]);

    channel.up = true;
    await vi.waitFor(() => expect(channel.delivered).toEqual([REPLY]), { timeout: 10_000, interval: 25 });
    await settle();
    expect(channel.delivered).toEqual([REPLY]);
  });

  it("is sent by the next bridge when this one stops before the channel is back", async () => {
    vi.stubEnv("CERASE_ACP_STATE_DIR", join(dir, "state"));
    const before: Channel = { delivered: [], refused: 0, loginWorks: false, up: false, refuseWhileUp: false };
    await boot(before);
    await inject(false);
    await turnEnded();
    await handle?.shutdown();
    handle = undefined;
    expect(before.delivered).toEqual([]);

    const after: Channel = { delivered: [], refused: 0, loginWorks: true, up: false, refuseWhileUp: false };
    await boot(after);
    await vi.waitFor(() => expect(after.delivered).toEqual([REPLY]), { timeout: 10_000, interval: 25 });
    await settle();
    expect(after.delivered).toEqual([REPLY]);
  });

  it("is not kept when the channel is up and refuses the message itself", async () => {
    const channel: Channel = { delivered: [], refused: 0, loginWorks: true, up: false, refuseWhileUp: true };
    await boot(channel);
    await inject(false);
    await vi.waitFor(async () => expect((await injects()).failed).toBe(1), { timeout: 15_000, interval: 50 });
    const refused = channel.refused;
    channel.refuseWhileUp = false;
    await settle();
    expect(channel.delivered).toEqual([]);
    expect(channel.refused).toBe(refused);
  });
});

// The console rewrites an agent's bot token while a turn of it runs: the
// adapter the turn's replies were made for is stopped, and a new one carries
// the agent from then on.
describe("a reply its turn sends after the adapter was replaced", { timeout: 40_000 }, () => {
  const SENTENCE =
    "Sto leggendo la proposta approvata e preparo il riepilogo per il cliente, con le voci e gli importi.";
  const LONG = `${SENTENCE} ${SENTENCE} ${SENTENCE}`;
  const tokenYaml = (token: string) => `
agents:
  - id: vittorio
    bot_token: ${token}
    allowed_users: ["111"]
    spawn:
      command: env
      args: ["--", "FAKE_REPLY=${LONG}", "FAKE_CHUNKS=6", "FAKE_DELAY_MS_PER_CHUNK=500", "node", "${FAKE_CHILD}"]
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`;

  it("goes out through the new adapter instead of being lost on the old one", async () => {
    const delivered: string[] = [];
    const refusedByOld: string[] = [];
    writeFileSync(path, tokenYaml("tok-1"));
    handle = await runBridge({
      config: loadConfig(path, process.env),
      bridgeE2eTest: false,
      configPath: path,
      createAdapter: async (agent) => {
        const token = agent.bot_token ?? "";
        let live = false;
        return {
          agentId: agent.id,
          async start() {
            live = true;
          },
          async stop() {
            live = false;
          },
          ready: () => live,
          makeSendTarget:
            () =>
            async (chunk: string): Promise<DeliveryResult> => {
              if (!live) {
                refusedByOld.push(chunk);
                return { ok: false, error: new Error(REFUSED) };
              }
              delivered.push(`${token}: ${chunk}`);
              return { ok: true };
            },
        };
      },
    });
    await inject(false);
    // The turn is under way, and its reply streams for three seconds.
    await vi.waitFor(
      async () => {
        const res = await fetch(`${handle?.internalUrl}/internal/status`, {
          headers: { authorization: `Bearer ${SECRET}` },
        });
        const body = (await res.json()) as { agents: Array<{ id: string; turnsInFlight?: number }> };
        expect(body.agents.find((a) => a.id === "vittorio")?.turnsInFlight).toBe(1);
      },
      { timeout: 10_000, interval: 25 },
    );
    writeFileSync(path, tokenYaml("tok-2"));
    await turnEnded();
    await settle();
    expect(delivered.length).toBeGreaterThan(0);
    for (const d of delivered) expect(d.startsWith("tok-2: ")).toBe(true);
    for (const chunk of refusedByOld) expect(delivered).toContain(`tok-2: ${chunk}`);
    // The pieces are cut wherever the stream paused, so they are compared
    // without the spaces a cut trims.
    const words = (t: string) => t.replace(/\s+/g, "");
    expect(words(delivered.map((d) => d.slice("tok-2: ".length)).join(""))).toContain(words(LONG));
  });
});

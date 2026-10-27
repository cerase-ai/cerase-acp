// A bot that shares no server with a person cannot DM them: Discord refuses
// every send with 50278 «Cannot send messages to this user», HTTP 400. On
// 21 October a tenant's assistant was in no server at all, so every DM failed
// that way, was retried three times, and the failure marker was posted into the
// same refused channel. These tests pin what the bridge has to do instead:
// keep the reply, report the refusal once on /internal/status, and send the
// kept reply when the adapter says the bot can reach people again.
//
// Each test boots the production bridge on a real agents.yaml, with a real ACP
// child, and drives the person's message through the internal server. Only the
// chat transport is scripted: it refuses the named people with the error
// discord.js raises, and records every attempt that reaches it.
//
// Names and ids are invented.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunBridgeHandle, runBridge } from "./bridge.js";
import type { ChatAdapter, DeliveryResult } from "./chat-adapter.js";
import { loadConfig } from "./config.js";
import type { PlatformNotice } from "./platform-notice.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));
const SECRET = "no-shared-server-secret";
const AGENT = "nora";
const REFUSED_USER = "210000000000000111";
const OTHER_USER = "210000000000000222";
const REPLY = "La nota è stata inoltrata al cliente.";

const NOTICE: PlatformNotice = {
  title: "Collega il tuo account",
  body: "«Nadia» può usare Gmail quando colleghi il tuo account.",
  link: { url: "https://example.test/c/abc", label: "Collega Gmail" },
};

let dir: string;
let path: string;
let handle: RunBridgeHandle | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-no-shared-server-"));
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

const agentYaml = (token: string) => `
agents:
  - id: ${AGENT}
    bot_token: ${token}
    allowed_users: ["${REFUSED_USER}", "${OTHER_USER}"]
    spawn:
      command: env
      args: ["--", "FAKE_REPLY=${REPLY}", "FAKE_CHUNKS=1", "node", "${FAKE_CHILD}"]
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`;

/** What discord.js raises when the bot and the person share no server. */
const noSharedServer = () =>
  Object.assign(new Error("Cannot send messages to this user"), { code: 50278, status: 400 });

interface Attempt {
  userId: string;
  chunk: string;
}

/** The scripted chat transport: who it refuses with 50278, and what reached whom. */
interface Channel {
  /** Every send that reached the adapter, accepted or refused, in order. */
  attempts: Attempt[];
  /** What the channel accepted, in order. */
  delivered: Attempt[];
  /** Every notice that reached the adapter, in order. */
  notices: Array<{ userId: string; notice: PlatformNotice }>;
  /** The people whose DMs are refused because the bot shares no server with them. */
  refusing: Set<string>;
  /** Whether the client is connected at all. */
  up: boolean;
}

function channelRefusing(...userIds: string[]): Channel {
  return { attempts: [], delivered: [], notices: [], refusing: new Set(userIds), up: false };
}

interface BootOptions {
  channel: Channel;
  yamlText?: string;
  /**
   * What each created adapter's start() throws, one entry per adapter the
   * bridge creates (boot, then each reload). Absent → that start succeeds.
   */
  starts?: Array<Error | undefined>;
  /** Whether the scripted adapter sends notices. Absent → it has no sendNotice. */
  notices?: boolean;
}

interface Booted {
  /** Call every onReachable listener the bridge registered, as the adapter would. */
  reachable(): void;
  /** How many adapters the bridge has created so far. */
  adapters(): number;
}

async function boot(opts: BootOptions): Promise<Booted> {
  const { channel } = opts;
  writeFileSync(path, opts.yamlText ?? agentYaml("tok-1"));
  const listeners: Array<() => void> = [];
  let created = 0;

  handle = await runBridge({
    config: loadConfig(path, process.env),
    bridgeE2eTest: false,
    configPath: path,
    createAdapter: async (agent) => {
      const generation = created++;
      const adapter: ChatAdapter & { onReachable(listener: () => void): void } = {
        agentId: agent.id,
        onReachable(listener: () => void) {
          listeners.push(listener);
        },
        async start() {
          const failure = opts.starts?.[generation];
          if (failure) {
            channel.up = false;
            throw failure;
          }
          channel.up = true;
        },
        async stop() {
          channel.up = false;
        },
        ready: () => channel.up,
        makeSendTarget:
          (userId: string) =>
          async (chunk: string): Promise<DeliveryResult> => {
            channel.attempts.push({ userId, chunk });
            if (!channel.up) {
              return { ok: false, error: new Error("Expected token to be set for this request") };
            }
            if (channel.refusing.has(userId)) {
              return { ok: false, error: noSharedServer() };
            }
            channel.delivered.push({ userId, chunk });
            return { ok: true };
          },
        ...(opts.notices
          ? {
              async sendNotice(userId: string, notice: PlatformNotice): Promise<DeliveryResult> {
                channel.notices.push({ userId, notice });
                if (channel.refusing.has(userId)) {
                  return { ok: false, error: noSharedServer() };
                }
                return {
                  ok: true,
                  ref: { channel: "discord", channelId: `dm-${userId}`, messageId: "m-1" },
                };
              },
            }
          : {}),
      };
      return adapter;
    },
  });

  return {
    reachable() {
      for (const listener of listeners) listener();
    },
    adapters: () => created,
  };
}

async function inject(userId: string, text = "La proposta è stata approvata."): Promise<void> {
  const res = await fetch(`${handle?.internalUrl}/internal/inject`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      agent_id: AGENT,
      user_id: userId,
      text,
      surface_in_chat: false,
    }),
  });
  expect(res.status).toBe(202);
}

async function injectNotice(userId: string): Promise<Response> {
  return fetch(`${handle?.internalUrl}/internal/inject`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      agent_id: AGENT,
      user_id: userId,
      text: "Collega il tuo account",
      system_message_only: true,
      notice: NOTICE,
    }),
  });
}

async function injects(): Promise<{ in_flight: number; succeeded: number; failed: number }> {
  const res = await fetch(`${handle?.internalUrl}/internal/status`, { headers: { authorization: `Bearer ${SECRET}` } });
  return ((await res.json()) as { inject: { in_flight: number; succeeded: number; failed: number } }).inject;
}

const turnEnded = (turns = 1) =>
  vi.waitFor(
    async () => {
      const s = await injects();
      expect(s.in_flight).toBe(0);
      expect(s.succeeded + s.failed).toBe(turns);
    },
    { timeout: 15_000, interval: 50 },
  );

interface Failure {
  kind: string;
  user_id?: string;
  detail?: string;
  code?: string;
}

async function statusOf(agentId: string): Promise<{ ready: boolean | null; failure?: Failure } | undefined> {
  const res = await fetch(`${handle?.internalUrl}/internal/status`, {
    headers: { authorization: `Bearer ${SECRET}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { agents: Array<{ id: string; ready: boolean | null; failure?: Failure }> };
  return body.agents.find((a) => a.id === agentId);
}

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a person whose DMs Discord refuses with 50278", { timeout: 40_000 }, () => {
  it("is sent the reply once and gets no failure marker; the reply is kept, not failed", async () => {
    const channel = channelRefusing(REFUSED_USER);
    await boot({ channel });

    await inject(REFUSED_USER);
    await turnEnded();
    await settle();

    // Exactly one attempt: no second try of the same chunk, and no
    // deliveryFailureNotice handed to the same refused channel.
    expect(channel.attempts).toEqual([{ userId: REFUSED_USER, chunk: REPLY }]);
    expect(channel.delivered).toEqual([]);

    // The turn did not fail: the answer exists, it is only waiting for a
    // channel that can carry it.
    expect(await injects()).toMatchObject({ succeeded: 1, failed: 0 });
  });

  it("is reported on /internal/status while the refusal stands", async () => {
    const channel = channelRefusing(REFUSED_USER);
    await boot({ channel });

    await inject(REFUSED_USER);
    await turnEnded();

    await vi.waitFor(
      async () => {
        expect((await statusOf(AGENT))?.failure?.kind).toBe("no_shared_server");
      },
      { timeout: 8000, interval: 50 },
    );

    const failure = (await statusOf(AGENT))?.failure;
    expect(failure?.user_id).toBe(REFUSED_USER);
    expect(typeof failure?.detail).toBe("string");
    expect(failure?.detail?.trim().length).toBeGreaterThan(0);
  });

  it("still reports a refused credential ahead of it when both apply", async () => {
    const channel = channelRefusing(REFUSED_USER);
    const tokenRefused = Object.assign(new Error("An invalid token was provided."), { code: "TokenInvalid" });
    const booted = await boot({ channel, starts: [undefined, tokenRefused] });

    await inject(REFUSED_USER);
    await turnEnded();
    await vi.waitFor(
      async () => {
        expect((await statusOf(AGENT))?.failure?.kind).toBe("no_shared_server");
      },
      { timeout: 8000, interval: 50 },
    );

    // The console rewrites the bot token while the refusal stands, and the
    // fresh adapter's login is refused. That is the failure a person must fix
    // first, so it is the one the status has to name.
    writeFileSync(path, agentYaml("tok-2"));
    await vi.waitFor(() => expect(booted.adapters()).toBe(2), { timeout: 8000, interval: 25 });
    await vi.waitFor(
      async () => {
        expect((await statusOf(AGENT))?.failure?.kind).toBe("credential_rejected");
      },
      { timeout: 8000, interval: 50 },
    );
    expect((await statusOf(AGENT))?.failure?.code).toBe("TokenInvalid");
  });

  it("has the kept reply sent when the adapter says the bot can reach people again", async () => {
    const channel = channelRefusing(REFUSED_USER);
    const booted = await boot({ channel });

    await inject(REFUSED_USER);
    await turnEnded();
    await vi.waitFor(
      async () => {
        expect((await statusOf(AGENT))?.failure?.kind).toBe("no_shared_server");
      },
      { timeout: 8000, interval: 50 },
    );
    expect(channel.delivered).toEqual([]);

    // The bot was added to a server: Discord now carries a DM to this person.
    channel.refusing.delete(REFUSED_USER);
    booted.reachable();

    await vi.waitFor(() => expect(channel.delivered).toEqual([{ userId: REFUSED_USER, chunk: REPLY }]), {
      timeout: 10_000,
      interval: 25,
    });
    await vi.waitFor(
      async () => {
        expect((await statusOf(AGENT))?.failure).toBeUndefined();
      },
      { timeout: 8000, interval: 50 },
    );
  });

  it("has the refusal cleared by a successful send to that person", async () => {
    const channel = channelRefusing(REFUSED_USER);
    await boot({ channel });

    await inject(REFUSED_USER);
    await turnEnded();
    await vi.waitFor(
      async () => {
        expect((await statusOf(AGENT))?.failure?.kind).toBe("no_shared_server");
      },
      { timeout: 8000, interval: 50 },
    );

    // The person can be reached again; the next message meets a channel that
    // accepts, and the kept reply goes with it.
    channel.refusing.delete(REFUSED_USER);
    await inject(REFUSED_USER, "Un'altra nota da inoltrare.");
    await turnEnded(2);

    await vi.waitFor(
      () =>
        expect(channel.delivered).toEqual([
          { userId: REFUSED_USER, chunk: REPLY },
          { userId: REFUSED_USER, chunk: REPLY },
        ]),
      { timeout: 10_000, interval: 25 },
    );
    await vi.waitFor(
      async () => {
        expect((await statusOf(AGENT))?.failure).toBeUndefined();
      },
      { timeout: 8000, interval: 50 },
    );
  });

  it("does not stop or report another person of the same agent", async () => {
    const channel = channelRefusing(REFUSED_USER);
    await boot({ channel });

    await inject(REFUSED_USER);
    await turnEnded();
    await vi.waitFor(
      async () => {
        expect((await statusOf(AGENT))?.failure?.user_id).toBe(REFUSED_USER);
      },
      { timeout: 8000, interval: 50 },
    );

    await inject(OTHER_USER);
    await turnEnded(2);

    expect(channel.delivered).toEqual([{ userId: OTHER_USER, chunk: REPLY }]);
    expect(channel.attempts.filter((a) => a.userId === OTHER_USER)).toHaveLength(1);
    const failure = (await statusOf(AGENT))?.failure;
    expect(failure?.kind).toBe("no_shared_server");
    expect(failure?.user_id).toBe(REFUSED_USER);
  });
});

// A notice meets the same 50278 as a reply. It is answered to the
// control-plane that sent it, attempted once, and the person is reported on
// /internal/status as a refused reply is.
describe("a notice Discord refuses with 50278", { timeout: 40_000 }, () => {
  it("answers no_shared_server once and reports the person on /internal/status", async () => {
    const channel = channelRefusing(REFUSED_USER);
    await boot({ channel, notices: true });

    const res = await injectNotice(REFUSED_USER);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("no_shared_server");
    expect(channel.notices).toHaveLength(1);
    expect(channel.notices[0]?.userId).toBe(REFUSED_USER);

    await vi.waitFor(
      async () => {
        const failure = (await statusOf(AGENT))?.failure;
        expect(failure?.kind).toBe("no_shared_server");
        expect(failure?.user_id).toBe(REFUSED_USER);
      },
      { timeout: 8000, interval: 50 },
    );
  });
});

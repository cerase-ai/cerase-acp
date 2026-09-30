// The pace of the writes into a Google Chat space, on fake timers.
//
// Google accepts one write a second in a space, counting posts, edits and
// deletes together, and answers 429 above it. The Google here applies that rule
// to the moment each request arrives by the fake clock, and answers at once, so
// a timeline of seconds runs without waiting for one. The Chat API, the token
// endpoint and the signing certificates are served by a stand-in for fetch;
// the one real socket is the webhook listener, reached as Google reaches it.

import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

import { makeServiceAccount, writeKeyFile } from "./__tests__/fake-google.js";
import type { ChatAdapter, DeliveryResult } from "./chat-adapter.js";
import { createChatAdapter } from "./chat-adapter.js";
import type { AgentConfig, BridgeConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import { deliveryFailureNotice } from "./platform-notices.js";
import type { SessionManager } from "./session-manager.js";
import { TurnMetaTracker } from "./turn-meta.js";
import { WORKSPACE_CHAT_EVENT_PATH, workspaceChatListenerPort } from "./workspace-chat-adapter.js";
import { ChatApiError, WorkspaceChatApi } from "./workspace-chat-api.js";
import { EMITTENTE, svuotaCache } from "./workspace-chat-verify.js";

process.env.WORKSPACE_CHAT_PORT = "0";

const API_ROOT = "https://chat.google.test";
const TOKEN_URI = "https://oauth2.google.test/token";
const CERTIFICATES_URL = "https://certs.google.test/chat";
const GIVEN_UP = "workspace-chat write refused for Google's rate limit, given up";
const SENT_AGAIN = "workspace-chat write refused for Google's rate limit, sent again after the wait";

// Written out rather than imported, so what the placeholder says is pinned here.
const BALLOON = "💬";
const ELLIPSIS = "…";

/** One request that wrote into a space, as the stand-in Google received it. */
interface Write {
  /** When it arrived, by the fake clock. */
  at: number;
  method: string;
  space: string;
  text: string;
  /** What Google answered. */
  status: number;
}

interface Refusal {
  status: number;
  retryAfter?: string;
}

/** Google's Chat API as far as writes go: posts, edits, and the one-a-second rule per space. */
function standInGoogle(certificates: Record<string, string> = {}) {
  const writes: Write[] = [];
  const lastAccepted = new Map<string, number>();
  const messages = new Map<string, string>();
  const refusals: { match: (w: Write) => boolean; refusal: Refusal; left: number }[] = [];
  const holds: { match: (w: Write) => boolean; released: Promise<void> }[] = [];
  let posted = 0;

  const tooMany = (retryAfter?: string) =>
    Response.json(
      {
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "Quota exceeded for quota metric 'Write requests per space'",
        },
      },
      { status: 429, headers: retryAfter === undefined ? {} : { "retry-after": retryAfter } },
    );

  async function fetchStub(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? "GET").toUpperCase();
    if (url.href === TOKEN_URI) return Response.json({ access_token: "access-token", expires_in: 3600 });
    if (url.href === CERTIFICATES_URL) {
      return Response.json(certificates, { headers: { "cache-control": "public, max-age=3600" } });
    }
    const post = method === "POST" ? /^\/v1\/(spaces\/[^/]+)\/messages$/.exec(url.pathname) : null;
    const patch = method === "PATCH" ? /^\/v1\/((spaces\/[^/]+)\/messages\/[^/]+)$/.exec(url.pathname) : null;
    const space = post?.[1] ?? patch?.[2];
    if (url.origin !== API_ROOT || space === undefined) {
      return Response.json({ error: { code: 404, status: "NOT_FOUND", message: "not served" } }, { status: 404 });
    }
    const body = JSON.parse(String(init.body ?? "{}")) as { text?: string };
    const write: Write = { at: Date.now(), method, space, text: body.text ?? "", status: 200 };
    writes.push(write);

    const scripted = refusals.find((r) => r.left > 0 && r.match(write));
    if (scripted) {
      scripted.left -= 1;
      write.status = scripted.refusal.status;
      return scripted.refusal.status === 429
        ? tooMany(scripted.refusal.retryAfter)
        : Response.json({ error: { code: scripted.refusal.status, message: "refused" } }, { status: write.status });
    }
    const last = lastAccepted.get(space);
    if (last !== undefined && write.at - last < 1000) {
      write.status = 429;
      return tooMany();
    }
    lastAccepted.set(space, write.at);
    let name = patch?.[1] ?? "";
    if (post) {
      posted += 1;
      name = `${space}/messages/${posted}`;
      messages.set(name, write.text);
    } else if (messages.has(name)) {
      messages.set(name, write.text);
    }
    // Carried out on arrival, answered once released.
    await holds.find((h) => h.match(write))?.released;
    return Response.json({ name, text: write.text });
  }

  return {
    fetch: fetchStub,
    writes,
    /** Refuses the next `times` writes `match` picks with this answer. */
    refuse(match: (w: Write) => boolean, refusal: Refusal, times = 1) {
      refusals.push({ match, refusal, left: times });
    },
    /** Answers the writes `match` picks only once the returned function is called. */
    hold(match: (w: Write) => boolean): () => void {
      let release = () => {};
      holds.push({ match, released: new Promise<void>((resolve) => (release = resolve)) });
      return release;
    },
    /** What each message in `space` says now, in the order they were posted. */
    shown(space: string): string[] {
      return [...messages.entries()].filter(([name]) => name.startsWith(`${space}/`)).map(([, text]) => text);
    },
  };
}

type StandInGoogle = ReturnType<typeof standInGoogle>;

/** The shortest time between two requests that arrived in one space, whatever they were answered. */
function closestPair(writes: Write[]): number {
  let closest = Number.POSITIVE_INFINITY;
  const last = new Map<string, number>();
  for (const w of writes) {
    const before = last.get(w.space);
    if (before !== undefined) closest = Math.min(closest, w.at - before);
    last.set(w.space, w.at);
  }
  return closest;
}

// Only the clock and the timers are fake. The listener's socket and the
// promise machinery run for real, which is what lets a test wait for the
// event to be handled without moving the clock.
const useFakeClock = () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-09-30T09:00:00.000Z"));
};

/** Lets real I/O and pending promises run, without moving the fake clock, until `check` holds. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`never happened: ${what}`);
}

describe("Google Chat writes: one a second in each space", () => {
  let google: StandInGoogle;
  let dir: string;
  let keyPath: string;
  let t0: number;

  beforeEach(() => {
    logs.length = 0;
    useFakeClock();
    t0 = Date.now();
    google = standInGoogle();
    vi.stubGlobal("fetch", google.fetch);
    dir = mkdtempSync(join(tmpdir(), "wc-pace-"));
    keyPath = join(dir, "service-account.json");
    writeKeyFile(keyPath, makeServiceAccount(), TOKEN_URI);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  const api = () => new WorkspaceChatApi({ keyPath, apiRoot: API_ROOT });
  const timeline = (space?: string) =>
    google.writes.filter((w) => space === undefined || w.space === space).map((w) => [w.at - t0, w.text, w.status]);

  it("posts and edits into one space are sent a second apart, in the order they were asked for", async () => {
    const client = api();
    const done = Promise.all([
      client.createMessage("spaces/A", "uno"),
      client.createMessage("spaces/A", "due"),
      client.updateMessageText("spaces/A/messages/1", ELLIPSIS),
      client.createMessage("spaces/A", "tre"),
    ]);
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(google.writes.map((w) => [w.at - t0, w.method, w.text, w.status])).toEqual([
      [0, "POST", "uno", 200],
      [1000, "POST", "due", 200],
      [2000, "PATCH", ELLIPSIS, 200],
      [3000, "POST", "tre", 200],
    ]);
    expect(google.shown("spaces/A")).toEqual([ELLIPSIS, "due", "tre"]);
  });

  it("writes into two spaces do not wait for each other", async () => {
    const client = api();
    const done = Promise.all([
      client.createMessage("spaces/A", "a1"),
      client.createMessage("spaces/A", "a2"),
      client.createMessage("spaces/B", "b1"),
      client.createMessage("spaces/B", "b2"),
    ]);
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(timeline("spaces/A")).toEqual([
      [0, "a1", 200],
      [1000, "a2", 200],
    ]);
    expect(timeline("spaces/B")).toEqual([
      [0, "b1", 200],
      [1000, "b2", 200],
    ]);
  });

  it("a write Google answers slowly holds the next one back by the second and no longer", async () => {
    const release = google.hold((w) => w.text === "lento");
    const client = api();
    const slow = client.createMessage("spaces/A", "lento");
    const next = client.createMessage("spaces/A", "dopo");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(next).resolves.toBe("spaces/A/messages/2");
    expect(timeline()).toEqual([
      [0, "lento", 200],
      [1000, "dopo", 200],
    ]);
    release();
    await expect(slow).resolves.toBe("spaces/A/messages/1");
  });

  it("a write refused for the rate is sent again after one, two and four seconds, and delivered", async () => {
    google.refuse((w) => w.text === "uno", { status: 429 }, 3);
    const sent = api().createMessage("spaces/A", "uno");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(sent).resolves.toBe("spaces/A/messages/1");
    expect(timeline()).toEqual([
      [0, "uno", 429],
      [1000, "uno", 429],
      [3000, "uno", 429],
      [7000, "uno", 200],
    ]);
    expect(logs.filter((l) => l.msg === SENT_AGAIN).map((l) => l.fields.waitMs)).toEqual([1000, 2000, 4000]);
    expect(logs.filter((l) => l.level === "error")).toEqual([]);
  });

  it("the wait a Retry-After names in seconds is kept, by the refused write and by every write behind it", async () => {
    google.refuse((w) => w.text === "uno", { status: 429, retryAfter: "5" });
    const client = api();
    const done = Promise.all([client.createMessage("spaces/A", "uno"), client.createMessage("spaces/A", "due")]);
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(timeline()).toEqual([
      [0, "uno", 429],
      [5000, "due", 200],
      [6000, "uno", 200],
    ]);
    expect(logs.find((l) => l.msg === SENT_AGAIN)?.fields).toMatchObject({ retryAfterMs: 5000, waitMs: 5000 });
  });

  it("the wait a Retry-After names as a date is kept", async () => {
    google.refuse((w) => w.text === "uno", { status: 429, retryAfter: new Date(t0 + 3000).toUTCString() });
    const sent = api().createMessage("spaces/A", "uno");
    await vi.advanceTimersByTimeAsync(10_000);
    await sent;
    expect(timeline()).toEqual([
      [0, "uno", 429],
      [3000, "uno", 200],
    ]);
  });

  it("a write refused for the rate five times is given up, logged once as an error, with Google's refusal to the caller", async () => {
    google.refuse(() => true, { status: 429 }, 100);
    const sent = api()
      .createMessage("spaces/A", "uno")
      .catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(60_000);
    const err = await sent;
    expect(err).toBeInstanceOf(ChatApiError);
    expect((err as ChatApiError).httpStatus).toBe(429);
    expect(timeline().map(([at]) => at)).toEqual([0, 1000, 3000, 7000, 15_000]);
    expect(logs.filter((l) => l.msg === SENT_AGAIN)).toHaveLength(4);
    const given = logs.filter((l) => l.level === "error");
    expect(given.map((l) => l.msg)).toEqual([GIVEN_UP]);
    expect(given[0]?.fields).toMatchObject({ what: "spaces.messages.create", space: "spaces/A", attempt: 5 });
  });

  it("a Retry-After longer than a minute is not waited for: the write is given up at once and logged", async () => {
    google.refuse(() => true, { status: 429, retryAfter: "120" });
    const sent = api()
      .createMessage("spaces/A", "uno")
      .catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await sent) as ChatApiError).toMatchObject({ httpStatus: 429, retryAfterMs: 120_000 });
    expect(timeline()).toEqual([[0, "uno", 429]]);
    expect(logs.filter((l) => l.level === "error").map((l) => l.fields)).toEqual([
      expect.objectContaining({ attempt: 1, waitMs: 120_000 }),
    ]);
  });

  it("a refusal for any other reason is returned at once and not sent again", async () => {
    google.refuse(() => true, { status: 403 });
    const sent = api()
      .createMessage("spaces/A", "uno")
      .catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await sent).toMatchObject({ httpStatus: 403 });
    expect(timeline()).toEqual([[0, "uno", 403]]);
  });
});

const PROJECT = "111111111111";
const KID = "chat-signing-key";
const signer = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SIGNER_PEM = signer.publicKey.export({ type: "spki", format: "pem" }).toString();

function chatJwt(aud: string): string {
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ aud, iss: EMITTENTE, iat: now - 5, exp: now + 300 })).toString("base64url");
  const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign(signer.privateKey).toString("base64url");
  return `Bearer ${head}.${body}.${signature}`;
}

/** A direct message from `email` in `space`, in the shape Google POSTs it. */
function chatEvent(email: string, space: string) {
  const dm = { name: space, type: "DM", spaceType: "DIRECT_MESSAGE", singleUserBotDm: true };
  const user = { name: `users/${email}`, email, type: "HUMAN" };
  const text = "ciao, mi prepari il riepilogo della settimana?";
  return {
    type: "MESSAGE",
    space: dm,
    user,
    message: { name: `${space}/messages/M1`, sender: user, text, space: dm, threadReply: false },
  };
}

/** POSTs an event to the listener as Google does, and answers the HTTP status. */
function deliver(event: unknown): Promise<number> {
  const body = JSON.stringify(event);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: workspaceChatListenerPort(),
        path: WORKSPACE_CHAT_EVENT_PATH,
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          authorization: chatJwt(PROJECT),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

interface Turn {
  userId: string;
  say(text: string): void;
  end(): void;
}

/** A session manager whose turns answer what the test tells them to, when it tells them to. */
function scriptedSessions(turns: Turn[]): SessionManager {
  const prompt: SessionManager["prompt"] = (_agentId, userId, _text, onUpdate) =>
    new Promise((resolve) => {
      turns.push({
        userId,
        say: (text) => onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }),
        end: () => resolve({ stopReason: "end_turn" }),
      });
    });
  // The dispatcher calls prompt() and nothing else on it.
  return { prompt } as unknown as SessionManager;
}

/** Five paragraphs, each long enough to be flushed and posted as a message of its own. */
const answer = (n: number) =>
  Array.from({ length: n }, (_, i) => `Parte ${i + 1} del riepilogo: ${"la settimana prosegue ".repeat(12).trim()}.`);

describe("Google Chat: a long answer arrives whole, at Google's pace", () => {
  const MARIO = "mario.rossi@example.com";
  const LUIGI = "luigi.verdi@example.com";
  let google: StandInGoogle;
  let dir: string;
  let adapter: ChatAdapter | undefined;
  let turns: Turn[];

  beforeEach(async () => {
    logs.length = 0;
    turns = [];
    useFakeClock();
    google = standInGoogle({ [KID]: SIGNER_PEM });
    vi.stubGlobal("fetch", google.fetch);
    svuotaCache();
    dir = mkdtempSync(join(tmpdir(), "wc-pace-adapter-"));
    const agent: AgentConfig = {
      id: "agent-1",
      channel: "workspace_chat",
      allowed_users: [MARIO, LUIGI],
      cwd: "/home/agent/cerase/workspace",
      mode: "cerase",
      spawn: { command: "docker", args: [] },
      workspace_chat: {
        project_number: PROJECT,
        credentials_path: join(dir, "agent-1.json"),
        certificates_url: CERTIFICATES_URL,
        api_root: API_ROOT,
      },
    };
    writeKeyFile(join(dir, "agent-1.json"), makeServiceAccount(), TOKEN_URI);
    const config: BridgeConfig = { agents: [agent], session: { idle_timeout_minutes: 60, max_concurrent: 16 } };
    const dispatcher = new Dispatcher({
      config,
      sessionManager: scriptedSessions(turns),
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: (_agentId, userId) => adapter!.makeSendTarget(userId),
    });
    adapter = await createChatAdapter(agent, dispatcher);
    await adapter.start();
  });

  afterEach(async () => {
    await adapter?.stop();
    adapter = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    svuotaCache();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A message from `email`, taken up by a turn that has posted its placeholder. */
  async function write(email: string, space: string): Promise<Turn> {
    expect(await deliver(chatEvent(email, space))).toBe(200);
    await until(
      () => turns.some((t) => t.userId === email) && google.writes.some((w) => w.space === space),
      `the turn and the placeholder for ${email}`,
    );
    return turns.find((t) => t.userId === email)!;
  }

  function answerWith(turn: Turn, parts: string[]) {
    for (const part of parts) turn.say(part);
    turn.end();
  }

  const inSpace = (space: string) => google.writes.filter((w) => w.space === space);

  it("a five-part answer and the placeholder's edit never make two writes into the space within a second, and the first part is not held back", async () => {
    const turn = await write(MARIO, "spaces/DM-MARIO");
    // A turn takes seconds; the answer is ready well after the placeholder.
    await vi.advanceTimersByTimeAsync(5000);
    const answeredAt = Date.now();
    const parts = answer(5);
    answerWith(turn, parts);
    await vi.advanceTimersByTimeAsync(30_000);

    const writes = inSpace("spaces/DM-MARIO");
    expect(writes.map((w) => [w.method, w.text, w.status])).toEqual([
      ["POST", BALLOON, 200],
      ["POST", parts[0], 200],
      ["PATCH", ELLIPSIS, 200],
      ["POST", parts[1], 200],
      ["POST", parts[2], 200],
      ["POST", parts[3], 200],
      ["POST", parts[4], 200],
    ]);
    expect(closestPair(writes)).toBeGreaterThanOrEqual(1000);
    expect(writes[1]?.at).toBe(answeredAt);
    expect(google.shown("spaces/DM-MARIO")).toEqual([ELLIPSIS, ...parts]);
    expect(logs.filter((l) => l.level === "error")).toEqual([]);
  });

  it("a part Google refuses for the rate is sent again after the wait it names, and every part arrives, in order", async () => {
    const parts = answer(5);
    google.refuse((w) => w.text === parts[2], { status: 429, retryAfter: "2" });
    const turn = await write(MARIO, "spaces/DM-MARIO");
    await vi.advanceTimersByTimeAsync(5000);
    answerWith(turn, parts);
    await vi.advanceTimersByTimeAsync(30_000);

    const writes = inSpace("spaces/DM-MARIO");
    expect(writes.map((w) => [w.text, w.status])).toEqual([
      [BALLOON, 200],
      [parts[0], 200],
      [ELLIPSIS, 200],
      [parts[1], 200],
      [parts[2], 429],
      [parts[2], 200],
      [parts[3], 200],
      [parts[4], 200],
    ]);
    const [refused, resent] = writes.filter((w) => w.text === parts[2]);
    expect(resent!.at - refused!.at).toBeGreaterThanOrEqual(2000);
    expect(closestPair(writes)).toBeGreaterThanOrEqual(1000);
    expect(google.shown("spaces/DM-MARIO")).toEqual([ELLIPSIS, ...parts]);
    expect(google.writes.some((w) => w.text === deliveryFailureNotice("it"))).toBe(false);
  });

  it("two people's conversations do not slow each other: each space keeps its own second", async () => {
    const mario = await write(MARIO, "spaces/DM-MARIO");
    const luigi = await write(LUIGI, "spaces/DM-LUIGI");
    await vi.advanceTimersByTimeAsync(5000);
    const answeredAt = Date.now();
    const parts = answer(3);
    answerWith(mario, parts);
    answerWith(luigi, parts);
    await vi.advanceTimersByTimeAsync(30_000);

    for (const space of ["spaces/DM-MARIO", "spaces/DM-LUIGI"]) {
      const writes = inSpace(space);
      expect(writes.map((w) => [w.at - answeredAt, w.text, w.status]).slice(1)).toEqual([
        [0, parts[0], 200],
        [1000, ELLIPSIS, 200],
        [2000, parts[1], 200],
        [3000, parts[2], 200],
      ]);
      expect(google.shown(space)).toEqual([ELLIPSIS, ...parts]);
    }
  });
});

describe("Discord keeps its own pace", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a five-part answer leaves the dispatcher's queue 100 ms apart", async () => {
    useFakeClock();
    const sent: { at: number; text: string }[] = [];
    const send = async (chunk: string): Promise<DeliveryResult> => {
      sent.push({ at: Date.now(), text: chunk });
      return { ok: true };
    };
    const turns: Turn[] = [];
    const config: BridgeConfig = {
      agents: [
        {
          id: "agent-d",
          channel: "discord",
          bot_token: "discord-bot-token",
          allowed_users: ["123456789012345678"],
          cwd: "/home/agent/cerase/workspace",
          mode: "cerase",
          spawn: { command: "docker", args: [] },
        },
      ],
      session: { idle_timeout_minutes: 60, max_concurrent: 16 },
    };
    const dispatcher = new Dispatcher({
      config,
      sessionManager: scriptedSessions(turns),
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: () => send,
    });
    const handled = dispatcher.handleMessage("agent-d", "123456789012345678", "ciao, mi prepari il riepilogo?");
    await until(() => turns.length === 1, "the turn");
    const answeredAt = Date.now();
    const parts = answer(5);
    for (const part of parts) turns[0]!.say(part);
    turns[0]!.end();
    await vi.advanceTimersByTimeAsync(2000);

    expect(await handled).toEqual({ ok: true });
    expect(sent.map((s) => [s.at - answeredAt, s.text])).toEqual(parts.map((p, i) => [i * 100, p]));
  });
});

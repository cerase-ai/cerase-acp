// The Workspace Chat webhook, driven the way Google drives it: one Chat app per
// assistant, one route for all of them, a signed event per message naming the
// app it was sent to, and the reply posted afterwards with that app's key.
//
// The dispatcher is the real one. Only the assistant is replaced, by a session
// manager whose turns end when the test says so, which is how a turn longer
// than Google's thirty-second deadline is expressed without waiting for one.
// Google's certificates, token endpoint and Chat API are fakes on loopback.

import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

import {
  type FakeGoogle,
  makeServiceAccount,
  type PostedMessage,
  startFakeGoogle,
  writeKeyFile,
} from "./__tests__/fake-google.js";
import type { ChatAdapter, DeliveryResult } from "./chat-adapter.js";
import { createChatAdapter } from "./chat-adapter.js";
import type { AgentConfig, BridgeConfig } from "./config.js";
import {
  Dispatcher,
  pickEmptyMessage,
  pickErrorMessage,
  pickRefusalMessage,
  pickTooLongMessage,
} from "./dispatcher.js";
import { directMessagesOnlyNotice, writingNotice } from "./platform-notices.js";
import { type SessionManager, TurnWatchdogError } from "./session-manager.js";
import { detectLanguage, TurnMetaTracker } from "./turn-meta.js";
import { WORKSPACE_CHAT_EVENT_PATH, workspaceChatListenerPort } from "./workspace-chat-adapter.js";
import { EMITTENTE, svuotaCache, URL_CERTIFICATI } from "./workspace-chat-verify.js";

process.env.WORKSPACE_CHAT_PORT = "0";

// Every accepted message is first answered by the line saying the assistant is
// writing. The tests about where and with which key a reply goes count replies,
// and leave that line to the tests about it.
const WRITING = new Set((["it", "en", "es", "fr"] as const).map((lang) => writingNotice(lang)));
const repliesIn = (google: FakeGoogle) => google.posts.filter((p) => !WRITING.has(p.text));

const PROJECT = "111111111111";
const PROJECT_2 = "222222222222";
const KID = "chat-signing-key";
const signer = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SIGNER_PEM = signer.publicKey.export({ type: "spki", format: "pem" }).toString();
const otherSigner = generateKeyPairSync("rsa", { modulusLength: 2048 });
const OTHER_SIGNER_PEM = otherSigner.publicKey.export({ type: "spki", format: "pem" }).toString();

function chatJwt(aud: string, by: { privateKey: KeyObject } = signer): string {
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ aud, iss: EMITTENTE, iat: now - 5, exp: now + 300 })).toString("base64url");
  const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign(by.privateKey).toString("base64url");
  return `Bearer ${head}.${body}.${signature}`;
}

interface EventOptions {
  type?: string;
  email?: string | undefined;
  userType?: string;
  text?: string;
  space?: string;
  spaceType?: string;
  thread?: string;
  threadReply?: boolean;
}

/** An interaction event in the shape Google Chat POSTs to an HTTP endpoint app. */
function chatEvent(o: EventOptions = {}) {
  const spaceName = o.space ?? "spaces/DM-MARIO";
  const space = {
    name: spaceName,
    type: (o.spaceType ?? "DIRECT_MESSAGE") === "DIRECT_MESSAGE" ? "DM" : "ROOM",
    spaceType: o.spaceType ?? "DIRECT_MESSAGE",
    singleUserBotDm: (o.spaceType ?? "DIRECT_MESSAGE") === "DIRECT_MESSAGE",
  };
  const user = {
    name: "users/104857600000000000000",
    displayName: "Mario Rossi",
    ...("email" in o ? (o.email === undefined ? {} : { email: o.email }) : { email: "mario.rossi@example.com" }),
    type: o.userType ?? "HUMAN",
    domainId: "C0example",
  };
  const text = o.text ?? "ciao, mi prepari il riepilogo della settimana?";
  return {
    type: o.type ?? "MESSAGE",
    eventTime: "2026-09-13T09:00:00.000000Z",
    space,
    user,
    message: {
      name: `${spaceName}/messages/M1`,
      sender: user,
      text,
      argumentText: text,
      thread: { name: o.thread ?? `${spaceName}/threads/T1` },
      threadReply: o.threadReply ?? false,
      space,
    },
  };
}

function agent(id: string, email: string, app: AgentConfig["workspace_chat"]): AgentConfig {
  return {
    id,
    channel: "workspace_chat",
    allowed_users: [email],
    cwd: "/home/agent/cerase/workspace",
    mode: "cerase",
    spawn: { command: "docker", args: [] },
    workspace_chat: app,
  };
}

interface HeldTurn {
  agentId: string;
  userId: string;
  text: string;
  end(reply: string): void;
}

describe("workspace-chat: one Chat app per assistant", () => {
  let google: FakeGoogle;
  let dir: string;
  let app: NonNullable<AgentConfig["workspace_chat"]>;
  let app2: NonNullable<AgentConfig["workspace_chat"]>;
  let account: ReturnType<typeof makeServiceAccount>;
  let account2: ReturnType<typeof makeServiceAccount>;
  let config: BridgeConfig;
  let dispatcher: Dispatcher;
  const adapters = new Map<string, ChatAdapter>();
  let turns: HeldTurn[];
  let turnWaiters: (() => void)[];
  let postWaiters: (() => void)[];

  const waitFor = (ready: () => boolean, waiters: (() => void)[]) =>
    new Promise<void>((resolve) => {
      const check = () => (ready() ? resolve() : waiters.push(check));
      check();
    });
  const turnCount = (n: number) => waitFor(() => turns.length >= n, turnWaiters);
  const postCount = (n: number) => waitFor(() => google.posts.length >= n, postWaiters);
  const replies = () => repliesIn(google);
  const replyCount = (n: number) => waitFor(() => replies().length >= n, postWaiters);

  async function startAgent(a: AgentConfig) {
    config.agents.push(a);
    const adapter = await createChatAdapter(a, dispatcher);
    await adapter.start();
    adapters.set(a.id, adapter);
    return adapter;
  }

  beforeEach(async () => {
    logs.length = 0;
    turns = [];
    turnWaiters = [];
    postWaiters = [];
    google = await startFakeGoogle();
    google.publishCertificates({ [KID]: SIGNER_PEM });
    account = makeServiceAccount("guido@project-one.iam.gserviceaccount.com");
    account2 = makeServiceAccount("enrico@project-two.iam.gserviceaccount.com");
    google.trust(account);
    google.trust(account2);
    google.onPost = () => {
      for (const w of postWaiters.splice(0)) w();
    };
    dir = mkdtempSync(join(tmpdir(), "wc-listener-"));
    app = {
      project_number: PROJECT,
      credentials_path: join(dir, "agent-1.json"),
      certificates_url: google.certificatesUrl,
      api_root: google.apiRoot,
    };
    app2 = { ...app, project_number: PROJECT_2, credentials_path: join(dir, "agent-2.json") };
    writeKeyFile(app.credentials_path!, account, google.tokenUri);
    writeKeyFile(app2.credentials_path!, account2, google.tokenUri);
    svuotaCache();

    config = { agents: [], session: { idle_timeout_minutes: 60, max_concurrent: 16 } };
    const sessionManager = {
      prompt: (agentId: string, userId: string, text: string, onUpdate?: (u: unknown) => void) =>
        new Promise((resolve) => {
          turns.push({
            agentId,
            userId,
            text,
            end: (reply) => {
              onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } });
              resolve({ stopReason: "end_turn" });
            },
          });
          for (const w of turnWaiters.splice(0)) w();
        }),
    } as unknown as SessionManager;
    dispatcher = new Dispatcher({
      config,
      sessionManager,
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: (agentId, userId) => adapters.get(agentId)!.makeSendTarget(userId),
    });

    await startAgent(agent("agent-1", "mario.rossi@example.com", app));
    await startAgent(agent("agent-2", "Anna.Bianchi@example.com", app2));
  });

  afterEach(async () => {
    for (const a of adapters.values()) await a.stop();
    adapters.clear();
    await google.close();
    svuotaCache();
    rmSync(dir, { recursive: true, force: true });
  });

  async function post(body: unknown, authorization: string | null = chatJwt(PROJECT), path = "/chat/event") {
    const resp = await fetch(`http://127.0.0.1:${workspaceChatListenerPort()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    return { status: resp.status, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
  }

  const reached = () => turns.map((t) => [t.agentId, t.userId]);

  it("the route Google calls is /chat/event", () => {
    expect(WORKSPACE_CHAT_EVENT_PATH).toBe("/chat/event");
  });

  it("a direct message to an assistant's app reaches that assistant, for its owner", async () => {
    expect(await post(chatEvent())).toEqual({ status: 200, body: {} });
    await turnCount(1);
    expect(
      await post(chatEvent({ email: "anna.bianchi@example.com", space: "spaces/DM-ANNA" }), chatJwt(PROJECT_2)),
    ).toEqual({
      status: 200,
      body: {},
    });
    await turnCount(2);
    expect(reached()).toEqual([
      ["agent-1", "mario.rossi@example.com"],
      ["agent-2", "Anna.Bianchi@example.com"],
    ]);
    expect(turns[0]!.text.endsWith("ciao, mi prepari il riepilogo della settimana?")).toBe(true);
  });

  it("the per-assistant paths of the old design are not routes", async () => {
    expect((await post(chatEvent(), chatJwt(PROJECT), "/agent-1/event")).status).toBe(404);
    expect((await post(chatEvent(), chatJwt(PROJECT), "/chat/agent-1/event")).status).toBe(404);
    const get = await fetch(`http://127.0.0.1:${workspaceChatListenerPort()}/chat/event`);
    expect(get.status).toBe(404);
    expect(reached()).toEqual([]);
  });

  // Without the signature the body decides who is speaking, and anybody who
  // can reach the URL could be answered by somebody else's assistant.
  it("an event without Google's signature is refused and reaches no assistant", async () => {
    expect(await post(chatEvent(), null)).toEqual({ status: 401, body: undefined });
    expect(reached()).toEqual([]);
  });

  it("an event signed for another Chat app is refused and reaches no assistant", async () => {
    expect(await post(chatEvent(), chatJwt("999999999999"))).toEqual({ status: 401, body: undefined });
    expect(reached()).toEqual([]);
  });

  // The configured address decides which keys sign a valid event. A test
  // serves its own there; a tenant's configuration names none and gets Google's.
  it("events are verified against the certificates at the configured address, fetched once while Google's max-age holds", async () => {
    expect(await post(chatEvent(), chatJwt(PROJECT, otherSigner))).toEqual({ status: 401, body: undefined });
    expect(await post(chatEvent())).toEqual({ status: 200, body: {} });
    await turnCount(1);
    expect(reached()).toEqual([["agent-1", "mario.rossi@example.com"]]);
    expect(google.certificateRequests()).toBe(1);
  });

  it("a verified sender with no assistant gets a short refusal and reaches none", async () => {
    const event = chatEvent({ email: "giulia.neri@example.com", text: "ciao, mi aiuti con il budget?" });
    expect(await post(event)).toEqual({
      status: 200,
      body: { text: pickRefusalMessage("ciao, mi aiuti con il budget?") },
    });
    expect(reached()).toEqual([]);
    expect(google.posts).toEqual([]);
  });

  // Each app is visible to its owner, but Google signs an event for anybody who
  // reaches it, and the body says who is writing. An assistant answers its owner
  // only: a colleague writing to it is refused, not handed its memory.
  it("a sender who is not the assistant's owner is refused, even when they own another assistant", async () => {
    const event = chatEvent({ email: "anna.bianchi@example.com", space: "spaces/DM-ANNA" });
    expect(await post(event)).toEqual({ status: 200, body: { text: pickRefusalMessage(event.message.text) } });
    expect(await post(chatEvent(), chatJwt(PROJECT_2))).toEqual({
      status: 200,
      body: { text: pickRefusalMessage(chatEvent().message.text) },
    });
    expect(reached()).toEqual([]);
  });

  it("an event with no sender email reaches no assistant", async () => {
    const event = chatEvent({ email: undefined });
    expect(await post(event)).toEqual({ status: 200, body: { text: pickRefusalMessage(event.message.text) } });
    expect(reached()).toEqual([]);
  });

  it("a message from another app reaches no assistant and gets no answer", async () => {
    expect(await post(chatEvent({ userType: "BOT" }))).toEqual({ status: 200, body: {} });
    expect(reached()).toEqual([]);
  });

  // In a group space the reply would be read by everybody in it, and the
  // assistant answers with its user's memory and connectors.
  it("a message in a group space gets a direct-messages-only note and reaches no assistant", async () => {
    const event = chatEvent({ spaceType: "SPACE", space: "spaces/TEAM" });
    expect(await post(event)).toEqual({
      status: 200,
      body: { text: directMessagesOnlyNotice(detectLanguage(event.message.text)) },
    });
    expect(reached()).toEqual([]);
  });

  // Two assistants given the same app by mistake, for the same person: the
  // event cannot say which one was meant.
  it("an app shared by two assistants of one person is refused rather than guessed", async () => {
    await startAgent(agent("agent-4", "MARIO.ROSSI@example.com", app));
    const event = chatEvent();
    expect(await post(event)).toEqual({ status: 200, body: { text: pickRefusalMessage(event.message.text) } });
    expect(reached()).toEqual([]);
    expect(logs.filter((l) => l.level === "error").map((l) => l.fields.agentIds)).toEqual([["agent-1", "agent-4"]]);
  });

  // A reload that changes only allowed_users replaces the array on the agent
  // object in place and restarts nothing, which is how an address corrected in
  // the console arrives. The listener has to see it on the next event.
  it("an address changed in place on reload routes the next event, and the old address no longer does", async () => {
    const seat = config.agents.find((a) => a.id === "agent-1")!;
    seat.allowed_users = ["m.rossi@example.com"];

    const old = chatEvent();
    expect(await post(old)).toEqual({ status: 200, body: { text: pickRefusalMessage(old.message.text) } });
    expect(await post(chatEvent({ email: "m.rossi@example.com" }))).toEqual({ status: 200, body: {} });
    await turnCount(1);
    expect(reached()).toEqual([["agent-1", "m.rossi@example.com"]]);
  });

  it("an event other than a message is acknowledged and does nothing", async () => {
    expect(await post(chatEvent({ type: "ADDED_TO_SPACE" }))).toEqual({ status: 200, body: {} });
    expect(reached()).toEqual([]);
  });

  // Google waits thirty seconds for the HTTP answer and then shows the user
  // an error. The acknowledgement is therefore sent before the turn starts,
  // and the reply is posted by the app when the turn ends, however long that
  // takes.
  it("the acknowledgement does not wait for the turn, and a turn that ends after it is posted into the event's thread", async () => {
    const event = chatEvent({ thread: "spaces/DM-MARIO/threads/T7", threadReply: true });
    expect(await post(event)).toEqual({ status: 200, body: {} });
    await turnCount(1);
    await postCount(1);
    expect(replies()).toEqual([]);

    turns[0]!.end("Ecco il riepilogo.");
    await replyCount(1);
    expect(replies()).toEqual([
      {
        space: "spaces/DM-MARIO",
        text: "Ecco il riepilogo.",
        thread: "spaces/DM-MARIO/threads/T7",
        messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
        authorization: "Bearer access-token-1",
      },
    ]);
  });

  it("a message written at the top of the conversation is answered at the top", async () => {
    await post(chatEvent({ threadReply: false }));
    await turnCount(1);
    turns[0]!.end("Fatto.");
    await replyCount(1);
    expect(replies().map((p) => [p.space, p.text, p.thread])).toEqual([["spaces/DM-MARIO", "Fatto.", undefined]]);
  });

  // Each turn answers where its own message was written, even when a later
  // message from the same person in another thread arrives before it ends.
  it("two turns running at once from one person are each answered in their own thread", async () => {
    await post(chatEvent({ thread: "spaces/DM-MARIO/threads/TA", threadReply: true, text: "prima domanda?" }));
    await turnCount(1);
    await post(chatEvent({ thread: "spaces/DM-MARIO/threads/TB", threadReply: true, text: "seconda domanda?" }));
    await turnCount(2);

    turns[1]!.end("Risposta alla seconda.");
    await replyCount(1);
    turns[0]!.end("Risposta alla prima.");
    await replyCount(2);
    expect(replies().map((p) => [p.text, p.thread])).toEqual([
      ["Risposta alla seconda.", "spaces/DM-MARIO/threads/TB"],
      ["Risposta alla prima.", "spaces/DM-MARIO/threads/TA"],
    ]);
  });

  // Each app authenticates as its own service account: a reply signed with
  // another assistant's key would be posted by that assistant's app.
  it("each assistant's reply is posted with its own app's key", async () => {
    await post(chatEvent());
    await turnCount(1);
    await post(chatEvent({ email: "anna.bianchi@example.com", space: "spaces/DM-ANNA" }), chatJwt(PROJECT_2));
    await turnCount(2);
    turns[0]!.end("Da Guido.");
    await replyCount(1);
    turns[1]!.end("Da Enrico.");
    await replyCount(2);
    const signer = (authorization: string | undefined) => {
      const n = Number(/access-token-(\d+)$/.exec(authorization ?? "")?.[1]);
      return google.assertions[n - 1]?.iss;
    };
    expect(replies().map((p) => [p.space, p.text, signer(p.authorization)])).toEqual([
      ["spaces/DM-MARIO", "Da Guido.", account.clientEmail],
      ["spaces/DM-ANNA", "Da Enrico.", account2.clientEmail],
    ]);
  });

  it("a reply Google refuses is logged with the space, the thread and Google's answer, and reported undelivered", async () => {
    await post(chatEvent({ thread: "spaces/DM-MARIO/threads/T9", threadReply: true }));
    await turnCount(1);
    turns[0]!.end("Prima risposta.");
    await replyCount(1);
    await vi.waitFor(() => expect(google.edits).toHaveLength(1));
    logs.length = 0;

    google.failNextPost(403, {
      error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" },
    });
    const result: DeliveryResult = await adapters.get("agent-1")!.makeSendTarget("mario.rossi@example.com")("Seconda.");

    expect(result.ok).toBe(false);
    expect(logs.filter((l) => l.name === "cerase-acp.workspace-chat" && l.level === "error")).toEqual([
      {
        name: "cerase-acp.workspace-chat",
        level: "error",
        fields: {
          agentId: "agent-1",
          userId: "mario.rossi@example.com",
          space: "spaces/DM-MARIO",
          thread: "spaces/DM-MARIO/threads/T9",
          httpStatus: 403,
          googleStatus: "PERMISSION_DENIED",
          reason:
            "spaces.messages.create on spaces/DM-MARIO failed: HTTP 403 PERMISSION_DENIED: The caller does not have permission",
        },
        msg: "workspace-chat reply not delivered",
      },
    ]);
  });

  // A scheduled message can be due for somebody who has not written since the
  // bridge started, so no event has told it where their conversation is.
  it("a message for a user with no event since start goes to their direct-message space", async () => {
    const result = await adapters.get("agent-2")!.makeSendTarget("Anna.Bianchi@example.com")("Promemoria.");
    expect(result).toEqual({ ok: true });
    expect(google.dmLookups).toEqual(["users/Anna.Bianchi@example.com"]);
    expect(google.posts.map((p) => [p.space, p.text, p.thread])).toEqual([
      ["spaces/dm-Anna-Bianchi-example-com", "Promemoria.", undefined],
    ]);
  });

  it("a reply written in Markdown is posted in Chat's own markup", async () => {
    const result = await adapters.get("agent-2")!.makeSendTarget("Anna.Bianchi@example.com")(
      "La nota **non** è stata creata.",
    );
    expect(result).toEqual({ ok: true });
    expect(google.posts.map((p) => p.text)).toEqual(["La nota *non* è stata creata."]);
  });
});

// Nothing listens once no assistant is on the channel: no app points at the
// machine then, so nothing Google sends can be meant for it.
describe("workspace-chat: the listener follows the assistants", () => {
  let google: FakeGoogle;
  let dir: string;
  let app: NonNullable<AgentConfig["workspace_chat"]>;
  let adapters: ChatAdapter[];

  async function post(body: unknown, authorization: string | null = chatJwt(PROJECT)) {
    const resp = await fetch(`http://127.0.0.1:${workspaceChatListenerPort()}${WORKSPACE_CHAT_EVENT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    return { status: resp.status, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
  }

  async function start(a: AgentConfig) {
    const adapter = await createChatAdapter(a, {} as unknown as Dispatcher);
    await adapter.start();
    adapters.push(adapter);
    return adapter;
  }

  beforeEach(async () => {
    logs.length = 0;
    adapters = [];
    google = await startFakeGoogle();
    google.publishCertificates({ [KID]: SIGNER_PEM });
    dir = mkdtempSync(join(tmpdir(), "wc-lifecycle-"));
    app = {
      project_number: PROJECT,
      credentials_path: join(dir, "agent-1.json"),
      certificates_url: google.certificatesUrl,
    };
    writeKeyFile(app.credentials_path!, makeServiceAccount(), "https://oauth2.googleapis.com/token");
    svuotaCache();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const a of adapters) await a.stop();
    await google.close();
    svuotaCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("the listener opens with the first assistant and closes with the last", async () => {
    expect(workspaceChatListenerPort()).toBeUndefined();
    const adapter = await start(agent("agent-1", "mario.rossi@example.com", app));
    expect(workspaceChatListenerPort()).toBeGreaterThan(0);
    await adapter.stop();
    adapters = [];
    expect(workspaceChatListenerPort()).toBeUndefined();
  });

  it("with no certificates_url, events are verified against the certificates Google publishes for Chat", async () => {
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).startsWith("http://127.0.0.1:")) return realFetch(input, init);
      asked.push(String(input));
      return Response.json({ [KID]: SIGNER_PEM }, { headers: { "cache-control": "public, max-age=3600" } });
    });
    const { certificates_url: _, ...withoutAddress } = app;
    await start(agent("agent-1", "mario.rossi@example.com", withoutAddress));

    const event = chatEvent({ email: "giulia.neri@example.com", text: "ciao, mi aiuti con il budget?" });
    expect(await post(event)).toEqual({ status: 200, body: { text: pickRefusalMessage(event.message.text) } });
    expect(asked).toEqual([URL_CERTIFICATI]);
    expect(URL_CERTIFICATI).toBe(
      "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat%40system.gserviceaccount.com",
    );
  });

  // Mid-reload two assistants' apps can name different addresses. A token
  // counts only against the certificates of the app whose project it was
  // issued for.
  it("two apps with different certificate addresses each accept only tokens their own certificates verify", async () => {
    const other = await startFakeGoogle();
    try {
      other.publishCertificates({ [KID]: OTHER_SIGNER_PEM });
      await start(agent("agent-1", "mario.rossi@example.com", app));
      await start(
        agent("agent-2", "anna.bianchi@example.com", {
          ...app,
          project_number: "222222222222",
          certificates_url: other.certificatesUrl,
        }),
      );

      const event = chatEvent({ email: "giulia.neri@example.com" });
      const refusal = { status: 200, body: { text: pickRefusalMessage(event.message.text) } };
      expect(await post(event, chatJwt(PROJECT))).toEqual(refusal);
      expect(await post(event, chatJwt("222222222222", otherSigner))).toEqual(refusal);
      expect(await post(event, chatJwt("222222222222"))).toEqual({ status: 401, body: undefined });
      expect(await post(event, chatJwt(PROJECT, otherSigner))).toEqual({ status: 401, body: undefined });
    } finally {
      await other.close();
    }
  });
});

// One person with two assistants: two Chat apps, each with its own direct
// message with them. The space an out-of-turn message goes to has to be the one
// of the app that posts it; the other app's is refused as not a member.
describe("workspace-chat: one person, two assistants, two direct-message spaces", () => {
  const MARIO = "mario.rossi@example.com";
  let google: FakeGoogle;
  let dir: string;
  let stateDir: string;
  let accountA: ReturnType<typeof makeServiceAccount>;
  let accountB: ReturnType<typeof makeServiceAccount>;
  let agents: AgentConfig[];
  let dispatcher: Dispatcher;
  const adapters = new Map<string, ChatAdapter>();
  const previousStateDir = process.env.CERASE_ACP_STATE_DIR;

  async function startAll() {
    for (const a of agents) {
      const adapter = await createChatAdapter(a, dispatcher);
      await adapter.start();
      adapters.set(a.id, adapter);
    }
  }

  /** What the bridge's restart does to the adapters: everything in memory is gone. */
  async function restart() {
    for (const a of adapters.values()) await a.stop();
    adapters.clear();
    await startAll();
  }

  const send = (agentId: string, text: string) => adapters.get(agentId)!.makeSendTarget(MARIO)(text);

  /** Which service account's token a post was made with. */
  const signer = (authorization: string | undefined) => {
    const n = Number(/access-token-(\d+)$/.exec(authorization ?? "")?.[1]);
    return google.assertions[n - 1]?.iss;
  };

  const stateFile = () => join(stateDir, "workspace-chat-spaces.json");

  beforeEach(async () => {
    logs.length = 0;
    google = await startFakeGoogle();
    google.publishCertificates({ [KID]: SIGNER_PEM });
    accountA = makeServiceAccount("guido@project-one.iam.gserviceaccount.com");
    accountB = makeServiceAccount("enrico@project-two.iam.gserviceaccount.com");
    google.trust(accountA);
    google.trust(accountB);
    dir = mkdtempSync(join(tmpdir(), "wc-two-apps-"));
    stateDir = join(dir, "state");
    process.env.CERASE_ACP_STATE_DIR = stateDir;
    const appA = {
      project_number: PROJECT,
      credentials_path: join(dir, "agent-1.json"),
      certificates_url: google.certificatesUrl,
      api_root: google.apiRoot,
    };
    const appB = { ...appA, project_number: PROJECT_2, credentials_path: join(dir, "agent-2.json") };
    writeKeyFile(appA.credentials_path, accountA, google.tokenUri);
    writeKeyFile(appB.credentials_path, accountB, google.tokenUri);
    svuotaCache();

    agents = [agent("agent-1", MARIO, appA), agent("agent-2", MARIO, appB)];
    const config: BridgeConfig = { agents, session: { idle_timeout_minutes: 60, max_concurrent: 16 } };
    const sessionManager = {
      prompt: async (_agentId: string, _userId: string, _text: string, onUpdate?: (u: unknown) => void) => {
        onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Ricevuto." } });
        return { stopReason: "end_turn" };
      },
    } as unknown as SessionManager;
    dispatcher = new Dispatcher({
      config,
      sessionManager,
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: (agentId, userId) => adapters.get(agentId)!.makeSendTarget(userId),
    });
    await startAll();
  });

  afterEach(async () => {
    for (const a of adapters.values()) await a.stop();
    adapters.clear();
    await google.close();
    svuotaCache();
    rmSync(dir, { recursive: true, force: true });
    if (previousStateDir === undefined) delete process.env.CERASE_ACP_STATE_DIR;
    else process.env.CERASE_ACP_STATE_DIR = previousStateDir;
  });

  async function writeTo(project: string, space: string) {
    const resp = await fetch(`http://127.0.0.1:${workspaceChatListenerPort()}/chat/event`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: chatJwt(project) },
      body: JSON.stringify(chatEvent({ space })),
    });
    expect(resp.status).toBe(200);
  }

  // The defect as it was met: both apps recorded their space under the person
  // alone, the file kept the second, and after a restart the first app's
  // every out-of-turn message was refused in the second app's space.
  it("each app posts in its own space after a restart", async () => {
    google.directMessages(accountA, ["spaces/DM-A"]);
    google.directMessages(accountB, ["spaces/DM-B"]);
    await writeTo(PROJECT, "spaces/DM-A");
    await vi.waitFor(() => expect(repliesIn(google)).toHaveLength(1));
    await writeTo(PROJECT_2, "spaces/DM-B");
    await vi.waitFor(() => expect(repliesIn(google)).toHaveLength(2));

    await restart();
    expect(await send("agent-1", "Promemoria uno.")).toEqual({ ok: true });
    expect(await send("agent-2", "Promemoria due.")).toEqual({ ok: true });

    expect(
      repliesIn(google)
        .slice(2)
        .map((p) => [p.space, p.text, signer(p.authorization)]),
    ).toEqual([
      ["spaces/DM-A", "Promemoria uno.", accountA.clientEmail],
      ["spaces/DM-B", "Promemoria due.", accountB.clientEmail],
    ]);
    expect(google.refusedPosts).toEqual([]);
    // Both were known from the file: nothing had to be looked up.
    expect(google.spaceLists).toEqual([]);
    expect(google.dmLookups).toEqual([]);
  });

  it("does not use a file in the earlier per-person shape", async () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFile(), JSON.stringify({ [MARIO]: "spaces/DM-B" }));
    google.directMessages(accountA, ["spaces/DM-A"]);
    google.directMessages(accountB, ["spaces/DM-B"]);
    await restart();

    expect(await send("agent-1", "Promemoria.")).toEqual({ ok: true });
    expect(google.attemptedPosts.map((p) => p.space)).toEqual(["spaces/DM-A"]);
    expect(JSON.parse(readFileSync(stateFile(), "utf8"))).toEqual({
      by_app: { [PROJECT]: { [MARIO]: "spaces/DM-A" } },
    });
  });

  // An app that belongs to one person is normally in one direct message, the
  // one with that person, and listing it is allowed with app authentication.
  it("uses and remembers the only direct-message space the app is in", async () => {
    google.directMessages(accountA, ["spaces/DM-A"]);
    expect(await send("agent-1", "Promemoria.")).toEqual({ ok: true });
    expect(google.posts.map((p) => [p.space, signer(p.authorization)])).toEqual([
      ["spaces/DM-A", accountA.clientEmail],
    ]);
    expect(google.spaceLists).toEqual([accountA.clientEmail]);
    expect(google.dmLookups).toEqual([]);

    await restart();
    expect(await send("agent-1", "Ancora.")).toEqual({ ok: true });
    expect(google.posts.map((p) => p.space)).toEqual(["spaces/DM-A", "spaces/DM-A"]);
    expect(google.spaceLists).toHaveLength(1);
  });

  // Several direct messages means people other than the owner have written to
  // the app too. Picking one could deliver the owner's message to one of them.
  it("does not choose among several direct-message spaces", async () => {
    google.directMessages(accountA, ["spaces/DM-A", "spaces/DM-SOMEONE-ELSE"]);
    await send("agent-1", "Promemoria.");
    expect(google.attemptedPosts.map((p) => p.space)).not.toContain("spaces/DM-A");
    expect(google.attemptedPosts.map((p) => p.space)).not.toContain("spaces/DM-SOMEONE-ELSE");
    // What happened before: the lookup by email, which real Google refuses to
    // a service account and this fake answers.
    expect(google.dmLookups).toEqual([`users/${MARIO}`]);
    await restart();
    await send("agent-1", "Ancora.");
    expect(google.spaceLists).toHaveLength(2);
  });

  it("drops a stored space the app is not in, finds its own, and posts there once more", async () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFile(), JSON.stringify({ by_app: { [PROJECT]: { [MARIO]: "spaces/DM-B" } } }));
    google.directMessages(accountA, ["spaces/DM-A"]);
    google.directMessages(accountB, ["spaces/DM-B"]);
    await restart();
    logs.length = 0;

    expect(await send("agent-1", "Promemoria.")).toEqual({ ok: true });
    expect(google.attemptedPosts.map((p) => p.space)).toEqual(["spaces/DM-B", "spaces/DM-A"]);
    expect(google.posts.map((p) => [p.space, p.text])).toEqual([["spaces/DM-A", "Promemoria."]]);
    expect(JSON.parse(readFileSync(stateFile(), "utf8"))).toEqual({
      by_app: { [PROJECT]: { [MARIO]: "spaces/DM-A" } },
    });
    const warned = logs.filter((l) => l.level === "warn" && l.name === "cerase-acp.workspace-chat");
    expect(warned).toHaveLength(1);
    expect(warned[0]!.fields).toMatchObject({ agentId: "agent-1", stored: "spaces/DM-B", replacement: "spaces/DM-A" });
  });

  it("reports a second refusal instead of trying again", async () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFile(), JSON.stringify({ by_app: { [PROJECT]: { [MARIO]: "spaces/DM-B" } } }));
    google.directMessages(accountA, ["spaces/DM-A"]);
    await restart();
    const refused = {
      error: { code: 403, message: "This Chat app is not a member of this space.", status: "PERMISSION_DENIED" },
    };
    google.failNextPost(403, refused);
    google.failNextPost(403, refused);
    google.failNextPost(403, refused);

    const result = await send("agent-1", "Promemoria.");
    expect(result.ok).toBe(false);
    expect(google.attemptedPosts.map((p) => p.space)).toEqual(["spaces/DM-B", "spaces/DM-A"]);
    expect(google.posts).toEqual([]);
  });
});

// Chat shows a person neither that an app read their message nor that it is
// writing, so the app posts a line saying so and, once the answer is on its
// way, rewrites that line to a single ellipsis. Each case below is a way a turn
// can end, and every one of them ends the same way: the line edited once, by
// the turn that posted it and no other, and nothing deleted. The answer is
// always a message of its own. None of it may cost the answer anything: a line
// Google refuses to post or to edit, or answers slowly, is logged and the
// answer goes out regardless.
describe("workspace-chat: the line that says the assistant is writing", () => {
  const MARIO = "mario.rossi@example.com";
  const IT = "ciao, mi prepari il riepilogo della settimana?";
  const WRITING_IT = writingNotice("it");
  // Written out rather than imported, so the character the line ends as is
  // pinned here and not only wherever the adapter takes it from.
  const ELLIPSIS = "…";
  const NOT_EDITED = "workspace-chat placeholder not edited; it still says the assistant is writing";
  let google: FakeGoogle;
  let dir: string;
  let app: NonNullable<AgentConfig["workspace_chat"]>;
  let config: BridgeConfig;
  let dispatcher: Dispatcher;
  let adapter: ChatAdapter | undefined;
  let turns: {
    text: string;
    say(text: string): void;
    end(reply?: string): void;
    fail(err: Error): void;
    ended: boolean;
  }[];

  const placeholders = () => google.posts.filter((p) => WRITING.has(p.text));
  const texts = (messages: { text: string }[]) => messages.map((m) => m.text);

  // Long enough for a request sent after the one a test waited for, a second
  // edit or a delete, to reach the fake on loopback and be counted.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  /**
   * The ending every path must reach, checked once the edits have landed and
   * any further request the turns sent has had time to land too: each of
   * `placeholders`, in that order, rewritten exactly once to the ellipsis with
   * only its text named in the mask, no other message edited, and no request
   * the fake does not serve, which is where a delete would go.
   */
  async function expectEachEndedOnce(...ended: PostedMessage[]) {
    await vi.waitFor(() => expect(google.edits.length).toBeGreaterThanOrEqual(ended.length));
    await settle();
    expect(google.edits.map((e) => [e.posted, e.text, e.updateMask])).toEqual(ended.map((p) => [p, ELLIPSIS, "text"]));
    expect(google.refusedEdits).toEqual([]);
    expect(google.unserved).toEqual([]);
  }

  async function startWith(d: Dispatcher) {
    await adapter?.stop();
    adapter = await createChatAdapter(config.agents[0]!, d);
    await adapter.start();
  }

  async function write(o: EventOptions = {}) {
    const resp = await fetch(`http://127.0.0.1:${workspaceChatListenerPort()}${WORKSPACE_CHAT_EVENT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: chatJwt(PROJECT) },
      body: JSON.stringify(chatEvent({ text: IT, ...o })),
    });
    expect(resp.status).toBe(200);
  }

  beforeEach(async () => {
    logs.length = 0;
    turns = [];
    google = await startFakeGoogle();
    google.publishCertificates({ [KID]: SIGNER_PEM });
    const account = makeServiceAccount("guido@project-one.iam.gserviceaccount.com");
    google.trust(account);
    dir = mkdtempSync(join(tmpdir(), "wc-writing-"));
    app = {
      project_number: PROJECT,
      credentials_path: join(dir, "agent-1.json"),
      certificates_url: google.certificatesUrl,
      api_root: google.apiRoot,
    };
    writeKeyFile(app.credentials_path!, account, google.tokenUri);
    svuotaCache();

    config = { agents: [agent("agent-1", MARIO, app)], session: { idle_timeout_minutes: 60, max_concurrent: 16 } };
    const sessionManager = {
      prompt: (_agentId: string, _userId: string, text: string, onUpdate?: (u: unknown) => void) =>
        new Promise((resolve, reject) => {
          const say = (t: string) =>
            onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
          const turn = {
            text,
            ended: false,
            say,
            end: (reply?: string) => {
              if (reply) say(reply);
              turn.ended = true;
              resolve({ stopReason: "end_turn" });
            },
            fail: (err: Error) => {
              turn.ended = true;
              reject(err);
            },
          };
          turns.push(turn);
        }),
    } as unknown as SessionManager;
    dispatcher = new Dispatcher({
      config,
      sessionManager,
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: (_agentId, userId) => adapter!.makeSendTarget(userId),
    });
    await startWith(dispatcher);
  });

  afterEach(async () => {
    await adapter?.stop();
    adapter = undefined;
    await google.close();
    svuotaCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is posted into the message's thread, and turns into an ellipsis once the first part of the answer is posted, while the turn still runs", async () => {
    await write({ thread: "spaces/DM-MARIO/threads/T7", threadReply: true });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    await vi.waitFor(() => expect(google.posts).toHaveLength(1));
    expect(google.posts.map((p) => [p.text, p.thread])).toEqual([[WRITING_IT, "spaces/DM-MARIO/threads/T7"]]);
    const [placeholder] = google.posts;

    // The answer is on screen before the line changes: the edit is sent once
    // the post has been answered, never ahead of it.
    let postedWhenEdited: string[] = [];
    google.onEdit = () => {
      postedWhenEdited = texts(google.posts);
    };
    const first = "Ecco la prima parte del riepilogo della settimana. ".repeat(6).trim();
    turns[0]!.say(first);
    await vi.waitFor(() => expect(google.edits).toHaveLength(1));
    expect(turns[0]!.ended).toBe(false);
    expect(postedWhenEdited).toEqual([WRITING_IT, first]);
    expect(google.shown()).toEqual([ELLIPSIS, first]);

    turns[0]!.end("E questo è il resto.");
    await vi.waitFor(() => expect(google.posts).toHaveLength(3));
    // The answer is posted as messages of its own, never written over the
    // placeholder: a new message is what makes the phone show the answer.
    expect(google.shown()).toEqual([ELLIPSIS, first, "E questo è il resto."]);
    expect(placeholders()).toEqual([placeholder]);
    await expectEachEndedOnce(placeholder!);
  });

  it("is posted once and edited once for an answer long enough to be sent in several messages, in the person's language", async () => {
    const english = "hello, can you help me with the difference between these two documents?";
    await write({ text: english });
    await vi.waitFor(() => expect(google.posts).toHaveLength(1));
    expect(texts(google.posts)).toEqual([writingNotice("en")]);
    const [placeholder] = google.posts;

    turns[0]!.end("This is one sentence of a long answer. ".repeat(70));
    await vi.waitFor(() => expect(google.posts.length).toBeGreaterThanOrEqual(3));
    await expectEachEndedOnce(placeholder!);
    expect(placeholders()).toEqual([placeholder]);
    const [top, ...answer] = google.shown();
    expect(top).toBe(ELLIPSIS);
    expect(answer.length).toBeGreaterThanOrEqual(2);
    expect(answer.some((t) => WRITING.has(t) || t === ELLIPSIS)).toBe(false);
  });

  it("turns into an ellipsis when the turn fails, and the failure notice follows it", async () => {
    await write();
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    await vi.waitFor(() => expect(google.posts).toHaveLength(1));
    turns[0]!.fail(new Error("the agent process exited"));
    await expectEachEndedOnce(google.posts[0]!);
    expect(google.shown()).toEqual([ELLIPSIS, pickErrorMessage(IT)]);
  });

  it("turns into an ellipsis when the turn runs past its time limit, and the notice saying so follows it", async () => {
    await write();
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    await vi.waitFor(() => expect(google.posts).toHaveLength(1));
    turns[0]!.fail(new TurnWatchdogError("ceiling", 600_000));
    await expectEachEndedOnce(google.posts[0]!);
    expect(google.shown()).toEqual([ELLIPSIS, pickTooLongMessage(IT)]);
  });

  it("turns into an ellipsis when the turn ends with an empty reply, and the notice saying so follows it", async () => {
    await write();
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    await vi.waitFor(() => expect(google.posts).toHaveLength(1));
    turns[0]!.end();
    await expectEachEndedOnce(google.posts[0]!);
    expect(google.shown()).toEqual([ELLIPSIS, pickEmptyMessage(IT)]);
  });

  // The one ending in which nothing at all is posted: all the turn wrote was
  // the engine's own summary, which never reaches the chat. No send target
  // runs, so only the turn's own exit can end the line.
  it("turns into an ellipsis when the turn ends with nothing posted at all", async () => {
    await write();
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    await vi.waitFor(() => expect(google.posts).toHaveLength(1));
    turns[0]!.end("## Objective\nriassumere\n\n## Work state\nin corso\n\n## Next move\nrispondere\n");
    await expectEachEndedOnce(google.posts[0]!);
    expect(google.shown()).toEqual([ELLIPSIS]);
    expect(google.posts).toHaveLength(1);
  });

  it("turns into an ellipsis when the handler throws before the dispatcher made a send target", async () => {
    await startWith({
      noticeLang: () => "it",
      handleMessage: async () => {
        throw new Error("unknown agent id");
      },
    } as unknown as Dispatcher);
    await write();
    await vi.waitFor(() => expect(google.posts).toHaveLength(1));
    await expectEachEndedOnce(google.posts[0]!);
    expect(google.shown()).toEqual([ELLIPSIS]);
  });

  // Two messages in quick succession are two turns, each with its own line.
  // A turn ends its own and no other, and a message sent to the person while
  // both run, a scheduled one, ends neither.
  it("belongs to its own turn: two turns from one person each edit their own, and a scheduled message edits none", async () => {
    await write({ thread: "spaces/DM-MARIO/threads/TA", threadReply: true, text: "prima domanda?" });
    await vi.waitFor(() => expect(google.posts).toHaveLength(1));
    await write({ thread: "spaces/DM-MARIO/threads/TB", threadReply: true, text: "seconda domanda?" });
    await vi.waitFor(() => expect(google.posts).toHaveLength(2));
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    expect(google.posts.map((p) => p.thread)).toEqual(["spaces/DM-MARIO/threads/TA", "spaces/DM-MARIO/threads/TB"]);
    const [placeholderA, placeholderB] = google.posts;

    expect(await adapter!.makeSendTarget(MARIO)("Promemoria.")).toEqual({ ok: true });
    await settle();
    expect(google.edits).toEqual([]);

    turns[0]!.end("Risposta alla prima.");
    await vi.waitFor(() => expect(google.edits).toHaveLength(1));
    await settle();
    expect(google.edits.map((e) => e.posted)).toEqual([placeholderA]);
    expect(google.shown()).toEqual([ELLIPSIS, WRITING_IT, "Promemoria.", "Risposta alla prima."]);

    turns[1]!.end("Risposta alla seconda.");
    await expectEachEndedOnce(placeholderA!, placeholderB!);
    expect(google.shown()).toEqual([
      ELLIPSIS,
      ELLIPSIS,
      "Promemoria.",
      "Risposta alla prima.",
      "Risposta alla seconda.",
    ]);
  });

  it("refused by Google is logged, and the turn and its answer go on without it", async () => {
    google.failNextPost(500, { error: { code: 500, message: "Internal error.", status: "INTERNAL" } });
    await write();
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    // The refusal is for the placeholder: the reply is written only once it has arrived.
    await vi.waitFor(() => expect(google.attemptedPosts).toHaveLength(1));
    turns[0]!.end("Ecco il riepilogo.");
    await vi.waitFor(() => expect(google.posts).toHaveLength(1));
    expect(texts(google.posts)).toEqual(["Ecco il riepilogo."]);
    await vi.waitFor(() =>
      expect(
        logs.filter((l) => l.msg === "workspace-chat placeholder not posted; the turn goes on without it"),
      ).toHaveLength(1),
    );
    // Nothing was posted, so there is nothing to edit, and the answer is not edited in its place.
    await expectEachEndedOnce();
    expect(google.shown()).toEqual(["Ecco il riepilogo."]);
    expect(logs.filter((l) => l.level === "error")).toEqual([]);
  });

  // Posted after the answer, the line ends below it rather than above: the
  // edit waits for the post it rewrites, and the answer waits for neither.
  it("answered slowly by Google does not hold up the turn, and still turns into an ellipsis once it lands after the answer", async () => {
    const release = google.holdNextPost();
    await write();
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    await vi.waitFor(() => expect(google.attemptedPosts).toHaveLength(1));
    turns[0]!.end("Ecco il riepilogo.");
    await vi.waitFor(() => expect(google.posts).toHaveLength(1));
    expect(texts(google.posts)).toEqual(["Ecco il riepilogo."]);
    expect(google.edits).toEqual([]);

    release();
    await vi.waitFor(() => expect(google.posts).toHaveLength(2));
    expect(texts(google.posts)).toEqual(["Ecco il riepilogo.", WRITING_IT]);
    await expectEachEndedOnce(google.posts[1]!);
    expect(google.shown()).toEqual(["Ecco il riepilogo.", ELLIPSIS]);
  });

  it("edited slowly does not hold up any part of the answer", async () => {
    const release = google.holdNextEdit();
    await write();
    await vi.waitFor(() => expect(google.posts).toHaveLength(1));
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    turns[0]!.end("This is one sentence of a long answer. ".repeat(70));
    await vi.waitFor(() => expect(google.posts.length).toBeGreaterThanOrEqual(3));
    expect(google.edits).toEqual([]);
    expect(google.shown()[0]).toBe(WRITING_IT);

    release();
    await expectEachEndedOnce(google.posts[0]!);
    expect(google.shown()[0]).toBe(ELLIPSIS);
  });

  it("that Google refuses to edit is logged once, not thrown and not retried, and the answer is delivered", async () => {
    google.failNextEdit(403, {
      error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" },
    });
    await write();
    await vi.waitFor(() => expect(google.posts).toHaveLength(1));
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    turns[0]!.end("Ecco il riepilogo.");
    await vi.waitFor(() => expect(logs.filter((l) => l.msg === NOT_EDITED)).toHaveLength(1));
    await settle();
    expect(logs.filter((l) => l.msg === NOT_EDITED)).toHaveLength(1);
    const warned = logs.find((l) => l.msg === NOT_EDITED)!;
    expect(warned).toMatchObject({ level: "warn", fields: { agentId: "agent-1", userId: MARIO } });
    expect(String(warned.fields.reason)).toContain(
      "spaces.messages.patch on spaces/DM-MARIO/messages/1 failed: HTTP 403",
    );
    // A retry would have gone through, since only the first edit is refused.
    expect(google.edits).toEqual([]);
    expect(google.shown()).toEqual([WRITING_IT, "Ecco il riepilogo."]);
    expect(google.unserved).toEqual([]);
    expect(logs.filter((l) => l.level === "error")).toEqual([]);
  });
});

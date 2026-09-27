// The Workspace Chat webhook, driven the way Google drives it: one Chat app per
// assistant, one route for all of them, a signed event per message naming the
// app it was sent to, and the reply posted afterwards with that app's key.
//
// The dispatcher is the real one. Only the assistant is replaced, by a session
// manager whose turns end when the test says so, which is how a turn longer
// than Google's thirty-second deadline is expressed without waiting for one.
// Google's certificates, token endpoint and Chat API are fakes on loopback.

import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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

import { type FakeGoogle, makeServiceAccount, startFakeGoogle, writeKeyFile } from "./__tests__/fake-google.js";
import type { ChatAdapter, DeliveryResult } from "./chat-adapter.js";
import { createChatAdapter } from "./chat-adapter.js";
import type { AgentConfig, BridgeConfig } from "./config.js";
import { Dispatcher, pickRefusalMessage } from "./dispatcher.js";
import { directMessagesOnlyNotice } from "./platform-notices.js";
import type { SessionManager } from "./session-manager.js";
import { detectLanguage, TurnMetaTracker } from "./turn-meta.js";
import { WORKSPACE_CHAT_EVENT_PATH, workspaceChatListenerPort } from "./workspace-chat-adapter.js";
import { EMITTENTE, svuotaCache, URL_CERTIFICATI } from "./workspace-chat-verify.js";

process.env.WORKSPACE_CHAT_PORT = "0";

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
    expect(google.posts).toEqual([]);

    turns[0]!.end("Ecco il riepilogo.");
    await postCount(1);
    expect(google.posts).toEqual([
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
    await postCount(1);
    expect(google.posts.map((p) => [p.space, p.text, p.thread])).toEqual([["spaces/DM-MARIO", "Fatto.", undefined]]);
  });

  // Each turn answers where its own message was written, even when a later
  // message from the same person in another thread arrives before it ends.
  it("two turns running at once from one person are each answered in their own thread", async () => {
    await post(chatEvent({ thread: "spaces/DM-MARIO/threads/TA", threadReply: true, text: "prima domanda?" }));
    await turnCount(1);
    await post(chatEvent({ thread: "spaces/DM-MARIO/threads/TB", threadReply: true, text: "seconda domanda?" }));
    await turnCount(2);

    turns[1]!.end("Risposta alla seconda.");
    await postCount(1);
    turns[0]!.end("Risposta alla prima.");
    await postCount(2);
    expect(google.posts.map((p) => [p.text, p.thread])).toEqual([
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
    await postCount(1);
    turns[1]!.end("Da Enrico.");
    await postCount(2);
    const signer = (authorization: string | undefined) => {
      const n = Number(/access-token-(\d+)$/.exec(authorization ?? "")?.[1]);
      return google.assertions[n - 1]?.iss;
    };
    expect(google.posts.map((p) => [p.space, p.text, signer(p.authorization)])).toEqual([
      ["spaces/DM-MARIO", "Da Guido.", account.clientEmail],
      ["spaces/DM-ANNA", "Da Enrico.", account2.clientEmail],
    ]);
  });

  it("a reply Google refuses is logged with the space, the thread and Google's answer, and reported undelivered", async () => {
    await post(chatEvent({ thread: "spaces/DM-MARIO/threads/T9", threadReply: true }));
    await turnCount(1);
    turns[0]!.end("Prima risposta.");
    await postCount(1);
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

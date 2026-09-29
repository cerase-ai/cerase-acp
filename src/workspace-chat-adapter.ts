// Google Workspace Chat adapter.
//
// Every assistant on the channel is its own Chat app, in its own Google Cloud
// project, as every assistant on Discord is its own bot (DEC-37 in cerase-core).
// Google POSTs every event for every app to one route, WORKSPACE_CHAT_EVENT_PATH,
// which the appliance's Traefik forwards unchanged to this listener. The
// project number the event's token was issued for names the app, and so the
// assistant; the verified sender's email must be that assistant's owner. The
// listener is open while at least one assistant is registered: with none, no
// app points at this machine.
//
// What the listener checks, in order, before any assistant is involved:
//   1. the Bearer JWT Google signs, against the project numbers served here;
//      nothing in the body is read before this passes
//   2. that the event is a message in a direct message
//   3. that exactly one assistant of that app lists the sender's address
// A request failing 1 gets a bare 401. An event failing 2 or 3 gets a short
// synchronous answer and reaches no assistant.
//
// An accepted message is acknowledged at once with an empty body and the turn
// runs after the HTTP exchange is over: Google waits thirty seconds for the
// answer and then shows the user an error, and a turn routinely takes longer.
// The reply is posted with spaces.messages.create under app authentication,
// into the space the message came from and into its thread when it was written
// in one.
//
// Chat shows a person neither that an app read their message nor that it is
// writing: a reaction needs user authentication and there is no typing call.
// So the app posts one line saying it is writing as soon as the message is
// accepted, and deletes it when the turn's first reply is posted, or when the
// turn ends without one. The answer is a message of its own, so the phone's
// notification carries the answer and not the placeholder.
//
// Direct messages only: no group spaces, no cards.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extractWorkspaceChatAttachments, type WorkspaceChatMessageLike } from "./channel-attachments.js";
import type { ChatAdapter, DeliveryResult } from "./chat-adapter.js";
import type { AgentConfig } from "./config.js";
import { type Dispatcher, pickRefusalMessage } from "./dispatcher.js";
import { buildOversizeNotice, ingestInboundBuffers, prependUploadMarker } from "./inbound-attachments.js";
import { makeLogger } from "./logger.js";
import { directMessagesOnlyNotice, writingNotice } from "./platform-notices.js";
import { detectLanguage } from "./turn-meta.js";
import {
  ChatApiError,
  GOOGLE_CHAT_API_ROOT,
  googleEndpointProblem,
  readServiceAccountKey,
  WorkspaceChatApi,
} from "./workspace-chat-api.js";
import { toChatText } from "./workspace-chat-format.js";
import { WorkspaceChatSpaces } from "./workspace-chat-spaces.js";
import { accettabile, URL_CERTIFICATI } from "./workspace-chat-verify.js";

const logger = makeLogger("cerase-acp.workspace-chat");

/** The one path Google calls: https://<appliance domain>/chat/event. */
export const WORKSPACE_CHAT_EVENT_PATH = "/chat/event";

interface ChatSpace {
  name?: string;
  type?: string;
  spaceType?: string;
}

interface ChatUser {
  email?: string;
  type?: string;
}

interface ChatEvent {
  type?: string;
  user?: ChatUser;
  space?: ChatSpace;
  message?: WorkspaceChatMessageLike & {
    text?: string;
    sender?: ChatUser;
    space?: ChatSpace;
    thread?: { name?: string };
    threadReply?: boolean;
  };
}

/** The assistant's own Chat app, as checked by start(). */
interface ChatApp {
  projectNumber: string;
  credentialsPath: string;
  /** Where the certificates Chat signs events with are fetched. */
  certificatesUrl: string;
  /** The Chat API's base URL, without a trailing slash. */
  apiRoot: string;
}

interface Route {
  agent: AgentConfig;
  app: ChatApp;
  accept(event: ChatEvent, userId: string): void;
}

/** Where a reply goes: the event's space, and its thread when the message was written inside one. */
interface Conversation {
  space: string | undefined;
  thread: string | undefined;
}

type Outcome = { kind: "ignore" } | { kind: "answer"; text: string } | { kind: "accept"; route: Route; userId: string };

// Keyed by agent id. Routes are few (one per seat) and matched by scanning the
// agent objects themselves, so an allowlist that a reload replaces in place is
// what the next event is matched against; nothing is copied at start().
const ROUTES = new Map<string, Route>();
const APIS = new Map<string, WorkspaceChatApi>();
let sharedServer: Server | undefined;

/** The port the webhook listener is bound to, or undefined while it is closed. */
export function workspaceChatListenerPort(): number | undefined {
  if (!sharedServer?.listening) return undefined;
  return (sharedServer.address() as AddressInfo).port;
}

function respond(res: ServerResponse, status: number, body?: unknown): void {
  res.statusCode = status;
  if (body === undefined) {
    res.end();
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isDirectMessage(space: ChatSpace | undefined): boolean {
  if (!space) return false;
  if (space.spaceType !== undefined) return space.spaceType === "DIRECT_MESSAGE";
  return space.type === "DM";
}

function decide(event: ChatEvent, candidates: Route[]): Outcome {
  if (event.type !== "MESSAGE") return { kind: "ignore" };
  const user = event.user ?? event.message?.sender;
  // Another app's message gets no answer at all: two apps refusing each other
  // is a loop.
  if (user?.type === "BOT") return { kind: "ignore" };

  const text = event.message?.text ?? "";
  if (!isDirectMessage(event.space ?? event.message?.space)) {
    return { kind: "answer", text: directMessagesOnlyNotice(detectLanguage(text)) };
  }
  const refusal: Outcome = { kind: "answer", text: pickRefusalMessage(text) };
  if (candidates.length === 0) {
    logger.info("workspace-chat event refused: no assistant is registered for this Chat app");
    return refusal;
  }

  const email = user?.email?.trim().toLowerCase() ?? "";
  const at = email.lastIndexOf("@");
  if (at <= 0) {
    logger.warn("workspace-chat event refused: the event carries no sender email");
    return refusal;
  }
  const domain = email.slice(at + 1);

  const matches = candidates.flatMap((route) => {
    const userId = route.agent.allowed_users.find((u) => u.trim().toLowerCase() === email);
    return userId === undefined ? [] : [{ route, userId }];
  });
  if (matches.length > 1) {
    logger.error(
      { agentIds: matches.map((m) => m.route.agent.id) },
      "workspace-chat event refused: the sender's address is listed by more than one assistant",
    );
    return refusal;
  }
  const match = matches[0];
  if (!match) {
    logger.info(
      { domain, agentIds: candidates.map((r) => r.agent.id) },
      "workspace-chat event refused: the sender does not own the assistant this app belongs to",
    );
    return refusal;
  }
  return { kind: "accept", route: match.route, userId: match.userId };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "").split("?")[0];
  // Every project served, under the address of the certificates its tokens are
  // checked with. All of them name the same address unless a reload that moved
  // it is still being applied.
  const served = new Map<string, string[]>();
  for (const app of [...ROUTES.values()].map((r) => r.app)) {
    const projects = served.get(app.certificatesUrl) ?? [];
    if (!projects.includes(app.projectNumber)) projects.push(app.projectNumber);
    served.set(app.certificatesUrl, projects);
  }
  if (req.method !== "POST" || path !== WORKSPACE_CHAT_EVENT_PATH || served.size === 0) {
    respond(res, 404);
    return;
  }
  // A 401 with no body: whoever failed verification is not told which check
  // they missed. The reason is in the log.
  const project = await accettabile(req.headers.authorization, served);
  if (project === undefined) {
    respond(res, 401);
    return;
  }

  let event: ChatEvent;
  try {
    event = JSON.parse(await readBody(req)) as ChatEvent;
  } catch {
    respond(res, 400);
    return;
  }

  const outcome = decide(
    event,
    [...ROUTES.values()].filter((r) => r.app.projectNumber === project),
  );
  if (outcome.kind === "answer") {
    respond(res, 200, { text: outcome.text });
    return;
  }
  respond(res, 200, {});
  if (outcome.kind === "accept") outcome.route.accept(event, outcome.userId);
}

async function ensureServerStarted(): Promise<void> {
  if (sharedServer) return;
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      logger.error({ err }, "workspace-chat listener failed on a request");
      if (!res.headersSent) respond(res, 500);
    });
  });
  sharedServer = server;
  const port = Number(process.env.WORKSPACE_CHAT_PORT ?? "7475");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, () => resolve());
    });
  } catch (err) {
    sharedServer = undefined;
    throw err;
  }
  logger.info(
    { port: workspaceChatListenerPort(), path: WORKSPACE_CHAT_EVENT_PATH },
    "workspace-chat listener started",
  );
}

/** Closes the listener once no assistant is served on it. */
async function closeServerIfUnused(): Promise<void> {
  if (ROUTES.size > 0 || !sharedServer) return;
  const server = sharedServer;
  sharedServer = undefined;
  APIS.clear();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function assistantApp(agent: AgentConfig): ChatApp {
  const wc = agent.workspace_chat;
  const missing = [
    wc?.project_number ? undefined : "workspace_chat.project_number",
    wc?.credentials_path ? undefined : "workspace_chat.credentials_path",
  ].filter((m) => m !== undefined);
  const problems = missing.length > 0 ? [`${missing.join(", ")} missing from agents.yaml`] : [];
  if (wc?.project_number && !/^\d+$/.test(wc.project_number)) {
    problems.push("workspace_chat.project_number must be the Google Cloud project number (digits only)");
  }
  for (const [key, value] of [
    ["workspace_chat.certificates_url", wc?.certificates_url],
    ["workspace_chat.api_root", wc?.api_root],
  ] as const) {
    const problem = value === undefined ? undefined : googleEndpointProblem(key, value);
    if (problem) problems.push(problem);
  }
  if (problems.length > 0 || !wc?.project_number || !wc.credentials_path) {
    throw new Error(`agent "${agent.id}" channel='workspace_chat' refuses to start: ${problems.join("; ")}`);
  }
  return {
    projectNumber: wc.project_number,
    credentialsPath: wc.credentials_path,
    certificatesUrl: wc.certificates_url ?? URL_CERTIFICATI,
    apiRoot: (wc.api_root ?? GOOGLE_CHAT_API_ROOT).replace(/\/+$/, ""),
  };
}

function apiFor(app: ChatApp): WorkspaceChatApi {
  const key = `${app.credentialsPath}\n${app.apiRoot}`;
  let api = APIS.get(key);
  if (!api) {
    api = new WorkspaceChatApi({ keyPath: app.credentialsPath, apiRoot: app.apiRoot });
    APIS.set(key, api);
  }
  return api;
}

/** Takes down a turn's placeholder. Idempotent, never rejects, and resolves once the delete has been answered. */
type RemovePlaceholder = () => Promise<void>;

/**
 * Posts the line saying the assistant is writing, and returns what deletes it.
 *
 * Neither half may cost the answer anything. The post is not awaited by the
 * turn, and a refused one is logged and leaves nothing to delete. The delete
 * waits for the post it undoes, so a placeholder that lands after the answer is
 * still taken down, and it is not awaited by the send that asks for it. Both
 * failures are logged and swallowed: a line left standing is a cosmetic defect,
 * an answer lost to it is not.
 */
function postPlaceholder(
  api: WorkspaceChatApi,
  conversation: Conversation & { space: string },
  text: string,
  context: { agentId: string; userId: string },
): RemovePlaceholder {
  const { space, thread } = conversation;
  const posted = api.createMessage(space, text, thread).then(
    (name) => {
      if (name === undefined) {
        logger.warn({ ...context, space }, "workspace-chat placeholder posted without a name, so it cannot be deleted");
      }
      return name;
    },
    (err: unknown) => {
      logger.warn(
        { ...context, space, thread, reason: (err as Error).message },
        "workspace-chat placeholder not posted; the turn goes on without it",
      );
      return undefined;
    },
  );
  let removed: Promise<void> | undefined;
  return () => {
    removed ??= posted.then(async (name) => {
      if (name === undefined) return;
      try {
        await api.deleteMessage(name);
      } catch (err) {
        logger.warn(
          { ...context, message: name, reason: (err as Error).message },
          "workspace-chat placeholder not deleted; it stays in the conversation",
        );
      }
    });
    return removed;
  };
}

/**
 * Whether a post was refused because the space is not this app's to post in:
 * the app is not a member of it, or it does not exist. Any other refusal says
 * nothing about the space.
 */
function wrongSpace(err: unknown): boolean {
  if (!(err instanceof ChatApiError)) return false;
  return err.httpStatus === 404 || (err.httpStatus === 403 && err.googleStatus === "PERMISSION_DENIED");
}

export function createWorkspaceChatAdapter(agent: AgentConfig, dispatcher: Dispatcher): ChatAdapter {
  let api: WorkspaceChatApi | undefined;
  const conversations = new Map<string, Conversation>();
  // The space each person last wrote to this assistant's app from, kept across
  // restarts: a message no event opened cannot ask Google for it by email with
  // a service account. Made at start(), where the app is known.
  let spaces: WorkspaceChatSpaces | undefined;
  // The placeholder of the turn about to call the dispatcher, until that turn's
  // send target takes it. Handed over rather than kept per person, because a
  // turn may delete its own placeholder only: a second message from the same
  // person has a placeholder of its own, and neither the first turn's reply nor
  // a scheduled message sent meanwhile may take it down.
  const placeholders = new Map<string, RemovePlaceholder>();

  /**
   * The person's direct-message space with this app, when no event and no
   * stored entry says. Listing the app's direct messages is allowed under app
   * authentication, and an app that belongs to one person usually has exactly
   * one: that one is used and remembered. With none or several the lookup by
   * email is tried as before, which Google refuses to a service account and
   * the caller logs; a space picked among several could be somebody else's.
   */
  async function resolveSpace(chat: WorkspaceChatApi, store: WorkspaceChatSpaces, userId: string): Promise<string> {
    try {
      const listed = await chat.listDirectMessageSpaces();
      const only = listed.spaces[0];
      if (listed.spaces.length === 1 && !listed.more && only) {
        store.remember(userId, only);
        logger.info(
          { agentId: agent.id, userId, space: only },
          "workspace-chat direct-message space found as the only one this app is in",
        );
        return only;
      }
      logger.info(
        { agentId: agent.id, userId, listed: listed.spaces.length, more: listed.more },
        "workspace-chat app is not in exactly one direct-message space; not choosing among them",
      );
    } catch (err) {
      logger.warn(
        { agentId: agent.id, userId, reason: (err as Error).message },
        "workspace-chat direct-message spaces could not be listed",
      );
    }
    return chat.findDirectMessage(userId);
  }

  async function runTurn(event: ChatEvent, userId: string, conversation: Conversation): Promise<void> {
    const text = event.message?.text ?? "";
    const refs = extractWorkspaceChatAttachments(event.message);
    if (!text && refs.length === 0) return;

    // Posted before the uploads are fetched, which can take longer than the
    // person should wait to see that the message arrived.
    const space = conversation.space;
    const writing = writingNotice(dispatcher.noticeLang(agent.id, userId, text));
    const removePlaceholder: RemovePlaceholder =
      api && space !== undefined
        ? postPlaceholder(api, { ...conversation, space }, writing, { agentId: agent.id, userId })
        : async () => {};
    try {
      let outText = text;
      if (refs.length > 0 && api) {
        const buffers: { name: string; bytes: Buffer }[] = [];
        for (const att of refs) {
          try {
            buffers.push({ name: att.name, bytes: await api.downloadMedia(att.resourceName) });
          } catch (err) {
            logger.warn(
              { agentId: agent.id, name: att.name, reason: (err as Error).message },
              "workspace-chat media download failed, attachment skipped",
            );
          }
        }
        const { stored, rejected } = await ingestInboundBuffers(`cerase-${agent.id}`, buffers, "workspace-chat");
        outText = prependUploadMarker(text, stored);
        const notice = buildOversizeNotice(rejected, "workspace-chat", detectLanguage(text));
        if (notice) {
          conversations.set(userId, conversation);
          await dispatcher.sendSystemMessage(agent.id, userId, notice);
        }
      }
      // The dispatcher asks for this turn's send target before its first
      // await, so the conversation and the placeholder set on the lines before
      // are the ones this reply uses, even when another message from the same
      // person arrives while it runs. The oversize notice above goes out before
      // the placeholder is handed over, so it leaves the placeholder standing.
      conversations.set(userId, conversation);
      placeholders.set(userId, removePlaceholder);
      spaces?.remember(userId, conversation.space);
      await dispatcher.handleMessage(agent.id, userId, outText);
    } finally {
      // The leak guard for a turn that posted nothing, or that threw before its
      // send target was made. A turn that answered has already asked for this,
      // and asking again costs nothing.
      if (placeholders.get(userId) === removePlaceholder) placeholders.delete(userId);
      void removePlaceholder();
    }
  }

  return {
    agentId: agent.id,
    // Ready while the webhook is serving this assistant: its route registered
    // and the listener bound. Without it the bridge reported nothing, and the
    // console read nothing as «never ready» and failed the machine's release.
    ready() {
      return ROUTES.has(agent.id) && api !== undefined && sharedServer?.listening === true;
    },
    async start() {
      const app = assistantApp(agent);
      // Read once here so a key the process cannot read downs this channel at
      // start, with the path and the reason, instead of at the first reply.
      readServiceAccountKey(app.credentialsPath);
      api = apiFor(app);
      spaces = new WorkspaceChatSpaces(process.env.CERASE_ACP_STATE_DIR, app.projectNumber);
      ROUTES.set(agent.id, {
        agent,
        app,
        accept: (event, userId) => {
          const conversation: Conversation = {
            space: (event.space ?? event.message?.space)?.name,
            thread: event.message?.threadReply === true ? event.message.thread?.name : undefined,
          };
          runTurn(event, userId, conversation).catch((err) => {
            logger.error(
              { agentId: agent.id, userId, reason: (err as Error).message },
              "workspace-chat turn failed after the event was acknowledged",
            );
          });
        },
      });
      try {
        await ensureServerStarted();
      } catch (err) {
        ROUTES.delete(agent.id);
        throw err;
      }
      logger.info({ agentId: agent.id, project: app.projectNumber }, "workspace-chat assistant registered");
    },
    async stop() {
      ROUTES.delete(agent.id);
      api = undefined;
      await closeServerIfUnused();
    },
    makeSendTarget(userId: string) {
      // Taken now, not at send time: see runTurn.
      const conversation = conversations.get(userId);
      const removePlaceholder = placeholders.get(userId);
      placeholders.delete(userId);
      return async (chunk: string): Promise<DeliveryResult> => {
        let space = conversation?.space;
        const thread = conversation?.thread;
        try {
          if (!api || !spaces) {
            throw new Error(`workspace-chat adapter for agent "${agent.id}" is not started, refusing to send`);
          }
          const text = toChatText(chunk);
          // No event from this person in this turn: a scheduled message, or a
          // reply after a restart. The space they last wrote from is used, and
          // one is looked for only for someone who never wrote.
          if (space === undefined) {
            const stored = spaces.known(userId);
            if (stored === undefined) {
              space = await resolveSpace(api, spaces, userId);
            } else {
              space = stored;
              try {
                await api.createMessage(stored, text, thread);
                return { ok: true };
              } catch (err) {
                if (!wrongSpace(err)) throw err;
                // A stored space this app cannot post in was recorded for
                // another app, or has gone. It is dropped and looked for once
                // more, and the message is posted once more below; a second
                // refusal is reported, not retried.
                spaces.forget(userId, stored);
                space = await resolveSpace(api, spaces, userId);
                logger.warn(
                  { agentId: agent.id, userId, stored, replacement: space, reason: (err as Error).message },
                  "workspace-chat stored direct-message space was wrong for this app; replaced and retried once",
                );
              }
            }
          }
          await api.createMessage(space, text, thread);
          return { ok: true };
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          logger.error(
            {
              agentId: agent.id,
              userId,
              space,
              thread,
              httpStatus: error instanceof ChatApiError ? error.httpStatus : undefined,
              googleStatus: error instanceof ChatApiError ? error.googleStatus : undefined,
              reason: error.message,
            },
            "workspace-chat reply not delivered",
          );
          return { ok: false, error };
        } finally {
          // After the post rather than before it, and not awaited: the answer
          // is on screen before the placeholder leaves, and a slow or refused
          // delete holds up neither this chunk nor the next.
          void removePlaceholder?.();
        }
      };
    },
  };
}

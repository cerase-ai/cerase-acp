// Google Workspace Chat adapter.
//
// One Chat app serves the whole organisation. Google POSTs every interaction
// event for that app to a single route, WORKSPACE_CHAT_EVENT_PATH, which the
// appliance's Traefik forwards unchanged to this listener. Every workspace_chat
// agent registers its user's address on the one listener, and the verified
// sender's email decides which assistant an event reaches. The listener is
// open while the configuration names the organisation's app or any assistant is
// registered, so a person with no assistant is refused instead of meeting a
// closed port.
//
// What the listener checks, in order, before any assistant is involved:
//   1. the Bearer JWT Google signs, against the project numbers served here;
//      nothing in the body is read before this passes
//   2. that the event is a message in a direct message
//   3. that the sender's email belongs to one of the organisation's domains
//   4. that exactly one assistant lists that address
// A request failing 1 gets a bare 401. An event failing 2 to 4 gets a short
// synchronous answer and reaches no assistant.
//
// An accepted message is acknowledged at once with an empty body and the turn
// runs after the HTTP exchange is over: Google waits thirty seconds for the
// answer and then shows the user an error, and a turn routinely takes longer.
// The reply is posted with spaces.messages.create under app authentication,
// into the space the message came from and into its thread when it was written
// in one.
//
// Direct messages only: no group spaces, no cards.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extractWorkspaceChatAttachments, type WorkspaceChatMessageLike } from "./channel-attachments.js";
import type { ChatAdapter, DeliveryResult } from "./chat-adapter.js";
import type { AgentConfig, WorkspaceChatAppConfig } from "./config.js";
import { type Dispatcher, pickRefusalMessage } from "./dispatcher.js";
import { buildOversizeNotice, ingestInboundBuffers, prependUploadMarker } from "./inbound-attachments.js";
import { makeLogger } from "./logger.js";
import { directMessagesOnlyNotice } from "./platform-notices.js";
import { detectLanguage } from "./turn-meta.js";
import {
  ChatApiError,
  GOOGLE_CHAT_API_ROOT,
  googleEndpointProblem,
  readServiceAccountKey,
  WorkspaceChatApi,
} from "./workspace-chat-api.js";
import { accettabile, URL_CERTIFICATI } from "./workspace-chat-verify.js";

const logger = makeLogger("cerase-acp.workspace-chat");

/** The one path Google calls: https://<appliance domain>/chat/event. */
export const WORKSPACE_CHAT_EVENT_PATH = "/chat/event";

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

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

/** The organisation's Chat app, as checked by start(). */
interface ChatApp {
  projectNumber: string;
  credentialsPath: string;
  allowedDomains: string[];
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
// The organisation's Chat app as the bridge configuration states it: its
// project number and where its signing certificates are fetched. While it is
// set the listener stays open with no route at all, and a verified event
// nobody's assistant can take is answered with the refusal: the appliance's
// proxy forwards the route regardless, and a closed port is a 502 that Google
// shows the person as a broken app.
let organisation: { projectNumber: string; certificatesUrl: string } | undefined;

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
  if (!candidates.some((r) => r.app.allowedDomains.includes(domain))) {
    logger.warn({ domain }, "workspace-chat event refused: the sender is outside the organisation's domains");
    return refusal;
  }

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
    logger.info({ domain }, "workspace-chat event refused: no assistant belongs to the sender");
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
  for (const app of [...[...ROUTES.values()].map((r) => r.app), ...(organisation ? [organisation] : [])]) {
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

/** Closes the listener once nothing is served on it: no route and no organisation app. */
async function closeServerIfUnused(): Promise<void> {
  if (ROUTES.size > 0 || organisation !== undefined || !sharedServer) return;
  const server = sharedServer;
  sharedServer = undefined;
  APIS.clear();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * Serves the organisation's Chat app on the webhook listener independently of
 * any assistant, or stops serving it with `undefined`. The bridge calls it at
 * boot and on every reload with the configuration's top-level block. An app
 * with no usable project number serves nothing, since no event could be
 * verified against it. Throws when the listener cannot be opened, and when
 * the app names a certificates address the endpoint rule refuses, after
 * withdrawing it.
 */
export async function serveWorkspaceChatApp(app: WorkspaceChatAppConfig | undefined): Promise<void> {
  const projectNumber = app?.project_number && /^\d+$/.test(app.project_number) ? app.project_number : undefined;
  const certificatesUrl = app?.certificates_url ?? URL_CERTIFICATI;
  const problem =
    projectNumber === undefined ? undefined : googleEndpointProblem("workspace_chat.certificates_url", certificatesUrl);
  // Set before any await, so an adapter stopping meanwhile sees it and leaves
  // the listener open.
  organisation = projectNumber === undefined || problem ? undefined : { projectNumber, certificatesUrl };
  if (organisation === undefined) {
    await closeServerIfUnused();
    if (problem) throw new Error(`the organisation's Workspace Chat app is not served: ${problem}`);
    return;
  }
  await ensureServerStarted();
}

function organisationApp(agent: AgentConfig): ChatApp {
  const wc = agent.workspace_chat;
  const missing = [
    wc?.project_number ? undefined : "workspace_chat.project_number",
    wc?.credentials_path ? undefined : "workspace_chat.credentials_path",
    wc?.allowed_domains?.length ? undefined : "workspace_chat.allowed_domains",
  ].filter((m) => m !== undefined);
  const problems = missing.length > 0 ? [`${missing.join(", ")} missing from agents.yaml`] : [];
  if (wc?.project_number && !/^\d+$/.test(wc.project_number)) {
    problems.push("workspace_chat.project_number must be the Google Cloud project number (digits only)");
  }
  const notDomains = (wc?.allowed_domains ?? []).filter((d) => !DOMAIN.test(d.trim().toLowerCase()));
  if (notDomains.length > 0) {
    problems.push(
      `workspace_chat.allowed_domains has ${notDomains.length === 1 ? "an entry that is not a domain" : "entries that are not domains"}: ${notDomains.join(", ")}`,
    );
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
    allowedDomains: (wc.allowed_domains ?? []).map((d) => d.trim().toLowerCase()),
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

export function createWorkspaceChatAdapter(agent: AgentConfig, dispatcher: Dispatcher): ChatAdapter {
  let api: WorkspaceChatApi | undefined;
  const conversations = new Map<string, Conversation>();

  async function runTurn(event: ChatEvent, userId: string, conversation: Conversation): Promise<void> {
    const text = event.message?.text ?? "";
    const refs = extractWorkspaceChatAttachments(event.message);
    if (!text && refs.length === 0) return;

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
    // The dispatcher asks for this turn's send target before its first await,
    // so the conversation set on the line before is the one this reply uses,
    // even when another message from the same person arrives while it runs.
    conversations.set(userId, conversation);
    await dispatcher.handleMessage(agent.id, userId, outText);
  }

  return {
    agentId: agent.id,
    async start() {
      const app = organisationApp(agent);
      // Read once here so a key the process cannot read downs this channel at
      // start, with the path and the reason, instead of at the first reply.
      readServiceAccountKey(app.credentialsPath);
      api = apiFor(app);
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
      return async (chunk: string): Promise<DeliveryResult> => {
        let space = conversation?.space;
        const thread = conversation?.thread;
        try {
          if (!api) {
            throw new Error(`workspace-chat adapter for agent "${agent.id}" is not started, refusing to send`);
          }
          // No event from this person since start: a scheduled message, or a
          // reply after a restart. Their direct-message space with the app is
          // asked of Google.
          space ??= await api.findDirectMessage(userId);
          await api.createMessage(space, chunk, thread);
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
        }
      };
    },
  };
}

// CHANNEL-4 (2026-05-31): Google Workspace Chat chat adapter.
//
// DM-only adapter implementing the ChatAdapter contract for a
// Workspace Chat bot. No upstream OSS adapter exists, so we wire
// the official @googleapis/chat SDK directly.
//
// Per-tenant setup (operator runbook in docs/operator/workspace-chat-setup.md):
//   1. Google Cloud project + Chat API enabled.
//   2. Service-account JSON key downloaded; path injected into
//      agents.yaml as workspace_chat_credentials_path (path is
//      inside the bridge container — see docker-compose.yml
//      volume mount).
//   3. Workspace Marketplace bot manifest published; Workspace
//      admin approves installation in the tenant's domain.
//   4. Webhook URL configured at the bot manifest: points at
//      the bridge's :7475 endpoint behind Traefik.
//
// Webhook ingress vs. long-polling: Workspace Chat does NOT
// support a Telegram-style "long-polling" pull model. Events are
// delivered via HTTP POST. This adapter starts an internal HTTP
// listener and the operator's appliance Traefik routes
// /chat/<agent-id>/event → bridge:7475/<agent-id>/event.
//
// Out of scope per the architecture brief:
//   - spaces (group rooms)
//   - threading
//   - card UI interactive components

import { makeLogger } from "./logger.js";
import type { AgentConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";
import type { ChatAdapter } from "./chat-adapter.js";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

const logger = makeLogger("cerase-acp.workspace-chat");

// All Workspace Chat adapters share a single HTTP listener (one bridge
// process — one port). The first adapter to start binds the port; the
// rest reuse the same server and register their per-agent handlers in
// a routing map by agent.id (matched in the URL path).
const ROUTES = new Map<
  string,
  (body: WorkspaceChatEvent) => Promise<WorkspaceChatReply | undefined>
>();
let sharedServer: Server | undefined;
const WORKSPACE_CHAT_PORT = Number(process.env.WORKSPACE_CHAT_PORT ?? "7475");

interface WorkspaceChatEvent {
  type?: string;
  user?: { name?: string; email?: string };
  message?: { text?: string };
}

interface WorkspaceChatReply {
  text: string;
}

async function ensureServerStarted(): Promise<void> {
  if (sharedServer) return;
  await new Promise<void>((resolve, reject) => {
    sharedServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      // URL shape: /<agent-id>/event
      const url = req.url ?? "";
      const match = /^\/([a-z0-9-]+)\/event$/i.exec(url);
      if (!match || req.method !== "POST") {
        res.statusCode = 404;
        res.end();
        return;
      }
      const agentId = match[1];
      if (!agentId) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const handler = ROUTES.get(agentId);
      if (!handler) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        void (async () => {
          try {
            const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const reply = await handler(body as WorkspaceChatEvent);
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(reply ?? {}));
          } catch (err) {
            logger.error({ err, agentId }, "workspace chat handler threw");
            res.statusCode = 500;
            res.end();
          }
        })();
      });
    });
    sharedServer.on("error", reject);
    sharedServer.listen(WORKSPACE_CHAT_PORT, () => {
      logger.info({ port: WORKSPACE_CHAT_PORT }, "workspace-chat HTTP listener started");
      resolve();
    });
  });
}

export function createWorkspaceChatAdapter(
  agent: AgentConfig,
  dispatcher: Dispatcher,
): ChatAdapter {
  if (!agent.workspace_chat_credentials_path) {
    throw new Error(
      `agent "${agent.id}" channel='workspace_chat' missing workspace_chat_credentials_path — should have been caught at config load via superRefine`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let chatClient: any | undefined;

  return {
    agentId: agent.id,
    async start() {
      // Lazy import the Google Chat client. @googleapis/chat is a thin
      // wrapper around the underlying googleapis package + the auth
      // helpers from google-auth-library.
      const { google } = await import("googleapis");
      const auth = new google.auth.GoogleAuth({
        keyFile: agent.workspace_chat_credentials_path,
        scopes: ["https://www.googleapis.com/auth/chat.bot"],
      });
      chatClient = google.chat({ version: "v1", auth });

      ROUTES.set(agent.id, async (event) => {
        if (event.type !== "MESSAGE") return undefined;
        const userId = event.user?.email;
        const text = event.message?.text ?? "";
        if (!userId || !text) return undefined;
        await dispatcher.handleMessage(agent.id, userId, text);
        // Acknowledge synchronously; reply chunks are sent
        // asynchronously via the send-target below using the Chat REST
        // API (spaces.messages.create). Workspace Chat tolerates an
        // empty sync reply when the bot acks via the REST API later.
        return { text: "" };
      });

      await ensureServerStarted();
      logger.info({ agentId: agent.id }, "workspace-chat bot route registered");
    },
    async stop() {
      ROUTES.delete(agent.id);
      // The shared HTTP server stays up as long as at least one
      // workspace_chat agent is registered. If we just removed the
      // last route, close it.
      if (ROUTES.size === 0 && sharedServer) {
        await new Promise<void>((resolve) => {
          sharedServer!.close(() => resolve());
        });
        sharedServer = undefined;
      }
    },
    makeSendTarget(userId: string) {
      return async (chunk: string) => {
        if (!chatClient) {
          throw new Error(
            `workspace-chat adapter for agent "${agent.id}" not started — refusing to send`,
          );
        }
        // The chat client posts to spaces.messages.create with the
        // user's DM space name. We resolve the user's DM space via
        // spaces.findDirectMessage which returns the canonical space
        // name `spaces/AAA…`. Cached per user inside this closure
        // would speed it up but is omitted for v0.1 simplicity.
        const space = await chatClient.spaces.findDirectMessage({
          name: `users/${userId}`,
        });
        await chatClient.spaces.messages.create({
          parent: space.data.name,
          requestBody: { text: chunk },
        });
      };
    },
  };
}

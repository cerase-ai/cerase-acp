// A stand-in for the parts of Discord the Discord adapter talks to: the REST
// gateway lookup, the unauthenticated gateway URL the reachability probe asks
// for, the three REST calls a reply makes (fetch the user, open the DM, post
// the message), and the gateway itself. All are served over real HTTP and
// WebSocket on loopback, so the installed discord.js runs its own login,
// reconnect and send code unchanged and nothing reaches the network. A request
// for anything else is answered 404 and recorded.
//
// The gateway speaks the opening of the real protocol: Hello on connect, then
// READY in answer to an Identify, or a close with `identifyCloseCode` when one
// is set, which is how Discord refuses a token (4004) or a privileged intent
// (4014). A Resume is answered with RESUMED.

import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
// The WebSocket library @discordjs/ws connects with, so the stand-in gateway
// speaks to the client in the same frames Discord's does.
import { type WebSocket, WebSocketServer } from "ws";

/** The bot's own user, as READY and every message it posts carry it. */
const BOT_USER = {
  id: "900000000000000001",
  username: "assistant",
  discriminator: "0",
  global_name: null,
  avatar: null,
  bot: true,
};

/** The one DM channel the fake opens, whoever it is opened with. */
export const FAKE_DM_CHANNEL_ID = "700000000000000001";

export interface FakeDiscordRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

export interface FakeDiscord {
  /** The REST base to hand discord.js as `rest.api`. */
  api: string;
  /** Close code the gateway answers an Identify with; null answers READY. Settable at any time. */
  identifyCloseCode: number | null;
  /** Answer the gateway lookup with a 401, as Discord answers a token it does not know. */
  refuseToken: boolean;
  /** Every REST request received, in order. */
  requests: FakeDiscordRequest[];
  /** Gateway connections opened since the fake started. */
  connections(): number;
  /** Gateway connections still open. */
  openConnections(): number;
  /** Close every open gateway connection with `code`, as Discord drops a session. */
  dropConnections(code: number): void;
  close(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export async function startFakeDiscord(
  init: { identifyCloseCode?: number | null; refuseToken?: boolean } = {},
): Promise<FakeDiscord> {
  const sockets = new Set<WebSocket>();
  let connections = 0;
  let sequence = 0;
  let messageId = 0;

  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      const body = await readJson(req);
      fake.requests.push({ method: req.method ?? "", path, authorization: req.headers.authorization, body });
      const answer = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
      };
      const { port } = server.address() as AddressInfo;
      const gatewayUrl = `ws://127.0.0.1:${port}`;

      if (req.method === "GET" && path === "/api/v10/gateway/bot") {
        if (fake.refuseToken) return answer(401, { message: "401: Unauthorized", code: 0 });
        return answer(200, {
          url: gatewayUrl,
          shards: 1,
          session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
        });
      }
      if (req.method === "GET" && path === "/api/v10/gateway") return answer(200, { url: gatewayUrl });
      const user = /^\/api\/v10\/users\/(\d+)$/.exec(path);
      if (req.method === "GET" && user) {
        return answer(200, { id: user[1], username: "person", discriminator: "0", global_name: null, avatar: null });
      }
      if (req.method === "POST" && path === "/api/v10/users/@me/channels") {
        const recipient = String((body as { recipient_id?: unknown } | undefined)?.recipient_id ?? "");
        return answer(200, {
          id: FAKE_DM_CHANNEL_ID,
          type: 1,
          last_message_id: null,
          recipients: [{ id: recipient, username: "person", discriminator: "0", global_name: null, avatar: null }],
        });
      }
      const channel = /^\/api\/v10\/channels\/(\d+)\/messages$/.exec(path);
      if (req.method === "POST" && channel) {
        messageId += 1;
        return answer(200, {
          id: String(800000000000000000 + messageId),
          channel_id: channel[1],
          author: BOT_USER,
          content: String((body as { content?: unknown } | undefined)?.content ?? ""),
          timestamp: new Date().toISOString(),
          edited_timestamp: null,
          tts: false,
          mention_everyone: false,
          mentions: [],
          mention_roles: [],
          attachments: [],
          embeds: [],
          pinned: false,
          type: 0,
        });
      }
      return answer(404, { message: "404: Not Found", code: 0 });
    })();
  });

  const gateway = new WebSocketServer({ server });
  gateway.on("connection", (socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
    socket.on("message", (raw) => {
      const payload = JSON.parse(String(raw)) as { op: number };
      const { port } = server.address() as AddressInfo;
      if (payload.op === 2) {
        if (fake.identifyCloseCode !== null) {
          socket.close(fake.identifyCloseCode);
          return;
        }
        sequence += 1;
        socket.send(
          JSON.stringify({
            op: 0,
            s: sequence,
            t: "READY",
            d: {
              v: 10,
              user: BOT_USER,
              guilds: [],
              session_id: `session-${connections}`,
              resume_gateway_url: `ws://127.0.0.1:${port}`,
              shard: [0, 1],
              application: { id: BOT_USER.id, flags: 0 },
            },
          }),
        );
      } else if (payload.op === 6) {
        sequence += 1;
        socket.send(JSON.stringify({ op: 0, s: sequence, t: "RESUMED", d: {} }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const fake: FakeDiscord = {
    api: `http://127.0.0.1:${port}/api`,
    identifyCloseCode: init.identifyCloseCode ?? null,
    refuseToken: init.refuseToken ?? false,
    requests: [],
    connections: () => connections,
    openConnections: () => sockets.size,
    dropConnections(code: number) {
      for (const socket of sockets) socket.close(code);
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      gateway.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return fake;
}

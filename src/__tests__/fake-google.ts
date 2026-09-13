// A stand-in for the two Google endpoints the Workspace Chat adapter talks to
// when it answers: the OAuth token endpoint that turns a service-account
// assertion into an access token, and the Chat REST API that the reply is
// posted to. Both are served over real HTTP on loopback, so the adapter's own
// request code runs unchanged and nothing reaches the network.
//
// The token endpoint checks what Google checks: the assertion's signature
// against the service account's public key, its issuer, its scope and its
// audience. A fake that accepted any assertion would let a broken signer pass.

import { createVerify, generateKeyPairSync, type KeyObject } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";

export interface ServiceAccount {
  clientEmail: string;
  privateKeyPem: string;
  publicKey: KeyObject;
}

export function makeServiceAccount(clientEmail = "cerase-chat@tenant-project.iam.gserviceaccount.com"): ServiceAccount {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    clientEmail,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey,
  };
}

/** Writes the key file exactly as the Cloud console hands it out, pointed at the fake token endpoint. */
export function writeKeyFile(path: string, account: ServiceAccount, tokenUri: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      type: "service_account",
      project_id: "tenant-project",
      private_key_id: "0123456789abcdef",
      private_key: account.privateKeyPem,
      client_email: account.clientEmail,
      client_id: "100000000000000000000",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: tokenUri,
      universe_domain: "googleapis.com",
    }),
  );
}

export interface PostedMessage {
  space: string;
  text: string;
  thread: string | undefined;
  messageReplyOption: string | null;
  authorization: string | undefined;
}

export interface FakeGoogle {
  /** Base URL of the fake Chat API, the value WORKSPACE_CHAT_API_ROOT takes. */
  apiRoot: string;
  tokenUri: string;
  /** Decoded claims of every assertion the token endpoint accepted, in order. */
  assertions: Record<string, unknown>[];
  /** Every call to the token endpoint, accepted or not. */
  tokenRequests(): number;
  posts: PostedMessage[];
  dmLookups: string[];
  /** Service accounts whose assertions the token endpoint accepts. */
  trust(account: ServiceAccount): void;
  /** Every access token issued so far stops being accepted by the Chat API. */
  revokeIssuedTokens(): void;
  /** The next post answers with this status and body instead of succeeding. */
  failNextPost(status: number, body: unknown): void;
  /** Called when a post arrives, before it is answered. */
  onPost: ((message: PostedMessage) => void) | undefined;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const trusted = new Map<string, KeyObject>();
  const valid = new Set<string>();
  const failures: { status: number; body: unknown }[] = [];
  let issued = 0;
  let tokenCalls = 0;

  const fake: Omit<FakeGoogle, "apiRoot" | "tokenUri" | "close"> = {
    assertions: [],
    tokenRequests: () => tokenCalls,
    posts: [],
    dmLookups: [],
    trust: (account) => trusted.set(account.clientEmail, account.publicKey),
    revokeIssuedTokens: () => valid.clear(),
    failNextPost: (status, body) => failures.push({ status, body }),
    onPost: undefined,
  };

  let tokenUri = "";

  const handleToken = async (req: IncomingMessage, res: ServerResponse) => {
    tokenCalls += 1;
    const form = new URLSearchParams(await readBody(req));
    const assertion = form.get("assertion") ?? "";
    const [head, claims, signature] = assertion.split(".");
    if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer" || !head || !claims || !signature) {
      return json(res, 400, { error: "invalid_request", error_description: "malformed assertion" });
    }
    const payload = JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as Record<string, unknown>;
    const key = trusted.get(String(payload.iss));
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${head}.${claims}`);
    if (!key || !verifier.verify(key, Buffer.from(signature, "base64url"))) {
      return json(res, 400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
    }
    if (payload.aud !== tokenUri || payload.scope !== CHAT_BOT_SCOPE) {
      return json(res, 400, { error: "invalid_scope", error_description: "wrong audience or scope" });
    }
    fake.assertions.push(payload);
    issued += 1;
    const accessToken = `access-token-${issued}`;
    valid.add(accessToken);
    return json(res, 200, { access_token: accessToken, expires_in: 3599, token_type: "Bearer" });
  };

  const authorised = (req: IncomingMessage) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    return m?.[1] !== undefined && valid.has(m[1]);
  };

  const unauthenticated = (res: ServerResponse) =>
    json(res, 401, {
      error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" },
    });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fake.google");
      if (req.method === "POST" && url.pathname === "/token") return handleToken(req, res);

      const post = /^\/v1\/(spaces\/[^/]+)\/messages$/.exec(url.pathname);
      if (req.method === "POST" && post?.[1]) {
        const body = JSON.parse(await readBody(req)) as { text?: string; thread?: { name?: string } };
        const message: PostedMessage = {
          space: post[1],
          text: body.text ?? "",
          thread: body.thread?.name,
          messageReplyOption: url.searchParams.get("messageReplyOption"),
          authorization: req.headers.authorization,
        };
        if (!authorised(req)) return unauthenticated(res);
        const failure = failures.shift();
        if (failure) return json(res, failure.status, failure.body);
        fake.posts.push(message);
        fake.onPost?.(message);
        return json(res, 200, { name: `${post[1]}/messages/${fake.posts.length}` });
      }

      if (req.method === "GET" && url.pathname === "/v1/spaces:findDirectMessage") {
        if (!authorised(req)) return unauthenticated(res);
        const name = url.searchParams.get("name") ?? "";
        fake.dmLookups.push(name);
        return json(res, 200, { name: `spaces/dm-${name.replace(/^users\//, "").replace(/[^a-z0-9]/gi, "-")}` });
      }

      const media = /^\/v1\/media\/(.+)$/.exec(url.pathname);
      if (req.method === "GET" && media?.[1] && url.searchParams.get("alt") === "media") {
        if (!authorised(req)) return unauthenticated(res);
        res.statusCode = 200;
        res.setHeader("content-type", "application/octet-stream");
        return res.end(Buffer.from(`bytes of ${decodeURIComponent(media[1])}`));
      }

      return json(res, 404, { error: { code: 404, message: "not found", status: "NOT_FOUND" } });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tokenUri = `${base}/token`;

  return Object.assign(fake, {
    apiRoot: base,
    tokenUri,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}

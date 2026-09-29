// A stand-in for the three Google endpoints the Workspace Chat adapter talks
// to: the certificates Chat signs its events with, the OAuth token endpoint
// that turns a service-account assertion into an access token, and the Chat
// REST API that the reply is posted to and a message's text rewritten on. All
// are served over real HTTP on loopback, so the adapter's own request code runs
// unchanged and nothing reaches the network. A request for anything else is
// answered 404, as Google answers an unknown path, and recorded, so a test can
// prove the adapter made no call the fake does not model.
//
// The token endpoint checks what Google checks: the assertion's signature
// against the service account's public key, its issuer, its scope and its
// audience. A fake that accepted any assertion would let a broken signer pass.

import { createVerify, generateKeyPairSync, type KeyObject } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";

const CERTIFICATES_PATH = "/service_accounts/v1/metadata/x509/chat%40system.gserviceaccount.com";

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
      private_key_id: "0".repeat(40),
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

export interface EditedMessage {
  /** The name Google gave the message when it was posted. */
  name: string;
  /** The message as it was posted. */
  posted: PostedMessage;
  /** The text the edit gave it. */
  text: string;
  /** The fields the edit asked to change, as the updateMask query parameter named them. */
  updateMask: string;
}

export interface FakeGoogle {
  /** Base URL of the fake Chat API, the value workspace_chat.api_root takes. */
  apiRoot: string;
  /** Where the signing certificates are served, the value workspace_chat.certificates_url takes. */
  certificatesUrl: string;
  tokenUri: string;
  /** The certificates served at certificatesUrl from now on, keyed by key id. */
  publishCertificates(certificates: Record<string, string>): void;
  /** Every request for the signing certificates. */
  certificateRequests(): number;
  /** Decoded claims of every assertion the token endpoint accepted, in order. */
  assertions: Record<string, unknown>[];
  /** Every call to the token endpoint, accepted or not. */
  tokenRequests(): number;
  posts: PostedMessage[];
  /** Every authorised post, whatever it was answered. */
  attemptedPosts: PostedMessage[];
  /** Posts refused because the posting app is not a member of the space. */
  refusedPosts: PostedMessage[];
  dmLookups: string[];
  /** The service account behind every spaces.list call, in order. */
  spaceLists: string[];
  /**
   * The direct-message spaces this account's app is a member of. A space given
   * to any account is one the other apps are not members of: a post into it
   * from them is refused as Google refuses it. Spaces given to nobody accept
   * every app.
   */
  directMessages(account: ServiceAccount, spaces: string[]): void;
  /** Service accounts whose assertions the token endpoint accepts. */
  trust(account: ServiceAccount): void;
  /** Every access token issued so far stops being accepted by the Chat API. */
  revokeIssuedTokens(): void;
  /** The next post answers with this status and body instead of succeeding. */
  failNextPost(status: number, body: unknown): void;
  /** The next post is not answered until the returned function is called. */
  holdNextPost(): () => void;
  /** Called when a post arrives, before it is answered. */
  onPost: ((message: PostedMessage) => void) | undefined;
  /** Every edit carried out, in the order the edits arrived. */
  edits: EditedMessage[];
  /**
   * Every edit refused because the name is no message the calling app posted:
   * unknown, or another app's. Google refuses these under app authentication;
   * here they are also the evidence that the adapter tried to edit something
   * that was not its own.
   */
  refusedEdits: string[];
  /** The next edit answers with this status and body instead of succeeding. */
  failNextEdit(status: number, body: unknown): void;
  /** The next edit is not answered until the returned function is called. */
  holdNextEdit(): () => void;
  /** Called when an edit has been carried out. */
  onEdit: ((edit: EditedMessage) => void) | undefined;
  /** What each posted message says now, in the order they were posted: the conversation as the person sees it. */
  shown(): string[];
  /** Every request the fake does not serve, as method and path: a delete, for one. */
  unserved: string[];
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
  // Which service account each access token was issued to.
  const owners = new Map<string, string>();
  const members = new Map<string, string[]>();
  const failures: { status: number; body: unknown }[] = [];
  const editFailures: { status: number; body: unknown }[] = [];
  const postHolds: Promise<void>[] = [];
  const editHolds: Promise<void>[] = [];
  // Every message posted, under the name it was given, with the account that
  // posted it and the text it says now.
  const messages = new Map<string, { message: PostedMessage; owner: string | undefined; text: string }>();
  const hold = (holds: Promise<void>[]) => {
    let release = () => {};
    holds.push(new Promise<void>((resolve) => (release = resolve)));
    return release;
  };
  let issued = 0;
  let tokenCalls = 0;
  let certificates: Record<string, string> = {};
  let certificateCalls = 0;

  const fake: Omit<FakeGoogle, "apiRoot" | "certificatesUrl" | "tokenUri" | "close"> = {
    publishCertificates: (published) => {
      certificates = published;
    },
    certificateRequests: () => certificateCalls,
    assertions: [],
    tokenRequests: () => tokenCalls,
    posts: [],
    attemptedPosts: [],
    refusedPosts: [],
    dmLookups: [],
    spaceLists: [],
    directMessages: (account, spaces) => members.set(account.clientEmail, spaces),
    trust: (account) => trusted.set(account.clientEmail, account.publicKey),
    revokeIssuedTokens: () => valid.clear(),
    failNextPost: (status, body) => failures.push({ status, body }),
    holdNextPost: () => hold(postHolds),
    onPost: undefined,
    edits: [],
    refusedEdits: [],
    failNextEdit: (status, body) => editFailures.push({ status, body }),
    holdNextEdit: () => hold(editHolds),
    onEdit: undefined,
    shown: () => [...messages.values()].map((m) => m.text),
    unserved: [],
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
    owners.set(accessToken, String(payload.iss));
    return json(res, 200, { access_token: accessToken, expires_in: 3599, token_type: "Bearer" });
  };

  const authorised = (req: IncomingMessage) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    return m?.[1] !== undefined && valid.has(m[1]);
  };

  const caller = (req: IncomingMessage) => owners.get(/^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "");

  const unauthenticated = (res: ServerResponse) =>
    json(res, 401, {
      error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" },
    });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fake.google");
      if (req.method === "POST" && url.pathname === "/token") return handleToken(req, res);

      if (req.method === "GET" && url.pathname === CERTIFICATES_PATH) {
        certificateCalls += 1;
        res.setHeader("cache-control", "public, max-age=3600");
        return json(res, 200, certificates);
      }

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
        fake.attemptedPosts.push(message);
        await postHolds.shift();
        const failure = failures.shift();
        if (failure) return json(res, failure.status, failure.body);
        const owned = [...members.values()].some((spaces) => spaces.includes(message.space));
        if (owned && !(members.get(caller(req) ?? "") ?? []).includes(message.space)) {
          fake.refusedPosts.push(message);
          return json(res, 403, {
            error: { code: 403, message: "This Chat app is not a member of this space.", status: "PERMISSION_DENIED" },
          });
        }
        fake.posts.push(message);
        const name = `${post[1]}/messages/${fake.posts.length}`;
        messages.set(name, { message, owner: caller(req), text: message.text });
        fake.onPost?.(message);
        return json(res, 200, { name, text: message.text });
      }

      // spaces.messages.patch changes only the fields its updateMask names, and
      // Google refuses a patch that names none. A text sent without the mask
      // saying so is ignored, as Google ignores it.
      const patch = /^\/v1\/(spaces\/[^/]+\/messages\/[^/]+)$/.exec(url.pathname);
      if (req.method === "PATCH" && patch?.[1]) {
        const body = JSON.parse((await readBody(req)) || "{}") as { text?: string };
        if (!authorised(req)) return unauthenticated(res);
        const updateMask = url.searchParams.get("updateMask") ?? "";
        if (updateMask === "") {
          return json(res, 400, {
            error: { code: 400, message: "update_mask is required.", status: "INVALID_ARGUMENT" },
          });
        }
        await editHolds.shift();
        const failure = editFailures.shift();
        if (failure) return json(res, failure.status, failure.body);
        const found = messages.get(patch[1]);
        if (!found || found.owner !== caller(req)) {
          fake.refusedEdits.push(patch[1]);
          return json(res, 404, { error: { code: 404, message: "Message not found.", status: "NOT_FOUND" } });
        }
        if (updateMask.split(",").includes("text")) found.text = body.text ?? "";
        const edit: EditedMessage = { name: patch[1], posted: found.message, text: found.text, updateMask };
        fake.edits.push(edit);
        fake.onEdit?.(edit);
        return json(res, 200, { name: patch[1], text: found.text });
      }

      if (req.method === "GET" && url.pathname === "/v1/spaces") {
        if (!authorised(req)) return unauthenticated(res);
        if (url.searchParams.get("filter") !== 'spaceType = "DIRECT_MESSAGE"') {
          return json(res, 400, { error: { code: 400, message: "invalid filter", status: "INVALID_ARGUMENT" } });
        }
        const who = caller(req) ?? "";
        fake.spaceLists.push(who);
        const all = members.get(who) ?? [];
        const size = Number(url.searchParams.get("pageSize") ?? "100");
        return json(res, 200, {
          spaces: all.slice(0, size).map((name) => ({ name, spaceType: "DIRECT_MESSAGE", singleUserBotDm: true })),
          ...(all.length > size ? { nextPageToken: "next" } : {}),
        });
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

      fake.unserved.push(`${req.method} ${url.pathname}`);
      return json(res, 404, { error: { code: 404, message: "not found", status: "NOT_FOUND" } });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tokenUri = `${base}/token`;

  return Object.assign(fake, {
    apiRoot: base,
    certificatesUrl: `${base}${CERTIFICATES_PATH}`,
    tokenUri,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}

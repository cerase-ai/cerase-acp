// The Google Chat REST calls the Workspace Chat adapter makes as the tenant's
// Chat app: posting a reply, rewriting the text of a message it posted,
// finding a user's direct-message space, listing the app's direct-message
// spaces and downloading an upload, each authorised with app authentication.
//
// App authentication is the OAuth 2.0 service-account flow: a JWT naming the
// service account, the chat.bot scope and the token endpoint, signed with the
// account's private key and exchanged at that endpoint for an access token.
// It is written out here, on node:crypto and fetch, rather than taken from
// googleapis, because the token endpoint and the API root then come from the
// key file and the configuration instead of constants inside the SDK, and the
// bridge's tests can run the real request code against fake endpoints on
// loopback.
//
// Google accepts one write a second in a space, counting posts, edits and
// deletes together and every app in the space together, and answers 429 above
// it (developers.google.com/workspace/chat/limits). Every post and edit made
// here therefore waits for its space's turn, and one Google refuses for that
// rate is sent again later instead of being lost.

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { makeLogger } from "./logger.js";

const logger = makeLogger("cerase-acp.workspace-chat.api");

export const CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
export const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
export const GOOGLE_CHAT_API_ROOT = "https://chat.googleapis.com";

const LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|\[::1\])$/;
const ENDPOINT_RULE = "must be an https URL, or an http URL to a host name without a dot or to a loopback address";

/**
 * Whether `value` may be the address of a Google endpoint: the signing
 * certificates and the Chat API named in the configuration, and the token
 * endpoint named in the service-account key.
 *
 * The addresses can be changed so a test can serve the endpoints itself.
 * Plaintext is accepted only toward a host name without a dot or a loopback
 * address, which is where such a stand-in runs. Toward any other host a
 * dropped letter in Google's own address would route the request through
 * anybody on the path: for the signing certificates the whole signature check,
 * for the token endpoint the signed assertion that buys the app's access.
 */
function acceptedGoogleEndpoint(value: string): boolean {
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (url?.protocol === "https:") return true;
  return url?.protocol === "http:" && (LOOPBACK.test(url.hostname) || !/[.[]/.test(url.hostname));
}

/** Why `value`, written under `key` in the configuration, cannot be the address of a Google endpoint, or undefined when it can. */
export function googleEndpointProblem(key: string, value: string): string | undefined {
  return acceptedGoogleEndpoint(value) ? undefined : `${key} ${ENDPOINT_RULE}, and ${JSON.stringify(value)} is neither`;
}

// Google issues an access token for an hour. It is renewed a minute before
// that, so a post that starts just before expiry does not arrive with a token
// Google has already stopped accepting.
const RENEW_MARGIN_MS = 60_000;
const ASSERTION_LIFETIME_SEC = 3600;

/** The shortest time between two writes into one space: Google allows one a second. */
export const SPACE_WRITE_INTERVAL_MS = 1000;

// A write refused with 429 is sent again after the wait its Retry-After names,
// or after 1, 2, 4 and 8 seconds when it names none, which is the exponential
// backoff Google asks for. The fifth refusal is final. A Retry-After longer
// than a minute is final at once: waiting it out would hold every later write
// into the space, and the rest of the answer, for longer than a person waits.
const RATE_LIMIT_ATTEMPTS = 5;
const FIRST_RATE_LIMIT_WAIT_MS = 1000;
const LONGEST_RATE_LIMIT_WAIT_MS = 60_000;

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri: string;
}

/** A call to Google that did not succeed, with what Google said about it. */
export class ChatApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | undefined,
    readonly googleStatus: string | undefined,
    /** How long a 429 asked the caller to wait, when its Retry-After said. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ChatApiError";
  }
}

/** A Retry-After header in milliseconds, in either of its two forms: seconds, or an HTTP date. */
function retryAfterMs(header: string | null): number | undefined {
  const value = header?.trim() ?? "";
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The order and the pace of the writes into each space.
 *
 * Writes into one space are sent in the order they were asked for, each at
 * least `intervalMs` after the one before it was sent; writes into different
 * spaces do not wait for each other. A write is timed from the moment it is
 * sent and not from Google's answer, so a write Google answers slowly holds
 * nothing behind it for longer than the interval.
 */
class SpaceWrites {
  private readonly spaces = new Map<string, { nextAt: number; queue: Promise<void> }>();

  constructor(private readonly intervalMs: number) {}

  /**
   * Resolves when a write into `space` may be sent, with the function that
   * records it as sent. That function must be called exactly when the request
   * leaves, or when the write is abandoned before it does; later calls do
   * nothing.
   */
  async turn(space: string): Promise<() => void> {
    let state = this.spaces.get(space);
    if (!state) {
      state = { nextAt: 0, queue: Promise.resolve() };
      this.spaces.set(space, state);
    }
    const before = state.queue;
    let release = () => {};
    state.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    // Checked again after every wait: a 429 answered meanwhile moves nextAt.
    for (let wait = state.nextAt - Date.now(); wait > 0; wait = state.nextAt - Date.now()) await sleep(wait);
    const ready = state;
    let sent = false;
    return () => {
      if (sent) return;
      sent = true;
      ready.nextAt = Math.max(ready.nextAt, Date.now() + this.intervalMs);
      release();
    };
  }

  /** Holds every write into `space` back for `ms` from now. */
  holdBack(space: string, ms: number): void {
    const state = this.spaces.get(space);
    if (state) state.nextAt = Math.max(state.nextAt, Date.now() + ms);
  }
}

/**
 * Reads and checks the service-account key the control-plane projects onto
 * disk. Every failure names the path and the reason, because the likeliest
 * one on an appliance is a permission the process does not have, and an error
 * that only says the channel is down sends the reader to Google instead. No
 * failure repeats a value from the file, which holds the app's private key.
 */
export function readServiceAccountKey(path: string): ServiceAccountKey {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
    const who =
      code === "EACCES" && process.getuid && process.getgroups
        ? `; this process runs as uid ${process.getuid()} with groups ${process.getgroups().join(",")} and needs read permission on the file and search permission on its directory`
        : "";
    throw new Error(`the Workspace Chat service-account key at ${path} cannot be read (${code})${who}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`the Workspace Chat service-account key at ${path} is not valid JSON`);
  }
  const missing = ["client_email", "private_key"].filter((k) => typeof parsed[k] !== "string" || parsed[k] === "");
  if (missing.length > 0) {
    throw new Error(`the Workspace Chat service-account key at ${path} has no ${missing.join(", ")}`);
  }
  const tokenUri =
    typeof parsed.token_uri === "string" && parsed.token_uri !== "" ? parsed.token_uri : GOOGLE_TOKEN_URI;
  if (!acceptedGoogleEndpoint(tokenUri)) {
    throw new Error(`the Workspace Chat service-account key at ${path} is refused: token_uri ${ENDPOINT_RULE}`);
  }
  return {
    client_email: parsed.client_email as string,
    private_key: parsed.private_key as string,
    private_key_id: typeof parsed.private_key_id === "string" ? parsed.private_key_id : undefined,
    token_uri: tokenUri,
  };
}

export interface WorkspaceChatApiOptions {
  /** Where the service-account key is; read again every time a token is renewed. */
  keyPath: string;
  /** The Chat API's base URL, without a trailing slash. */
  apiRoot: string;
  now?: () => number;
  /** The shortest time between two writes into one space. Google's limit unless a test sets its own. */
  writeIntervalMs?: number;
}

interface GoogleErrorBody {
  error?: string | { status?: string; message?: string };
  error_description?: string;
}

async function describeFailure(resp: Response): Promise<{ status?: string; reason: string }> {
  const text = await resp.text().catch(() => "");
  try {
    const body = JSON.parse(text) as GoogleErrorBody;
    if (body.error && typeof body.error === "object") {
      return { status: body.error.status, reason: `${body.error.status ?? ""}: ${body.error.message ?? ""}` };
    }
    if (typeof body.error === "string") {
      return { status: body.error, reason: `${body.error}: ${body.error_description ?? ""}` };
    }
  } catch {
    // Not JSON: a proxy's error page, or an empty body. The raw text is the only account there is.
  }
  return { reason: text.slice(0, 200) };
}

export class WorkspaceChatApi {
  private token: { value: string; expiresAt: number } | undefined;
  private readonly now: () => number;
  private readonly writes: SpaceWrites;

  constructor(private readonly opts: WorkspaceChatApiOptions) {
    this.now = opts.now ?? Date.now;
    this.writes = new SpaceWrites(opts.writeIntervalMs ?? SPACE_WRITE_INTERVAL_MS);
  }

  /**
   * `spaces.messages.create`: posts `text` into `space`, inside `thread` when
   * one is given, and returns the name Google gave the message.
   */
  async createMessage(space: string, text: string, thread?: string): Promise<string | undefined> {
    const query = thread ? "?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" : "";
    const body = thread ? { text, thread: { name: thread } } : { text };
    const resp = await this.write("spaces.messages.create", space, space, `/v1/${space}/messages${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const name = ((await resp.json().catch(() => ({}))) as { name?: unknown }).name;
    return typeof name === "string" && name !== "" ? name : undefined;
  }

  /**
   * `spaces.messages.patch` with `updateMask=text`: replaces the text of the
   * message called `name` and leaves the rest of it as it was. Under app
   * authentication Google edits only a message this app created, so a name
   * that is somebody else's message is refused rather than acted on.
   */
  async updateMessageText(name: string, text: string): Promise<void> {
    const space = name.split("/messages/")[0] ?? name;
    const resp = await this.write("spaces.messages.patch", name, space, `/v1/${name}?updateMask=text`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    await resp.body?.cancel();
  }

  /** `spaces.findDirectMessage`: the direct-message space between `email` and this app. */
  async findDirectMessage(email: string): Promise<string> {
    const user = `users/${email}`;
    const resp = await this.call(
      "spaces.findDirectMessage",
      user,
      `/v1/spaces:findDirectMessage?name=${encodeURIComponent(user)}`,
      { method: "GET" },
    );
    const space = ((await resp.json()) as { name?: string }).name;
    if (!space) {
      throw new ChatApiError(`spaces.findDirectMessage on ${user} returned no space name`, resp.status, undefined);
    }
    return space;
  }

  /**
   * `spaces.list` filtered to direct messages: the direct-message spaces this
   * app is a member of, at most `pageSize` of them, and whether Google has
   * more. Allowed under app authentication, unlike findDirectMessage by email.
   */
  async listDirectMessageSpaces(pageSize = 2): Promise<{ spaces: string[]; more: boolean }> {
    const query = new URLSearchParams({ filter: 'spaceType = "DIRECT_MESSAGE"', pageSize: String(pageSize) });
    const resp = await this.call("spaces.list", "direct messages", `/v1/spaces?${query}`, { method: "GET" });
    const body = (await resp.json()) as { spaces?: { name?: string }[]; nextPageToken?: string };
    const spaces = (body.spaces ?? []).map((s) => s.name).filter((n): n is string => typeof n === "string" && n !== "");
    return { spaces, more: typeof body.nextPageToken === "string" && body.nextPageToken !== "" };
  }

  /** `media.download`: the bytes of an uploaded attachment. */
  async downloadMedia(resourceName: string): Promise<Buffer> {
    const resp = await this.call("media.download", resourceName, `/v1/media/${resourceName}?alt=media`, {
      method: "GET",
    });
    return Buffer.from(await resp.arrayBuffer());
  }

  /**
   * A call that writes into `space`, sent in that space's turn. A refusal for
   * the rate, 429, is sent again in a later turn, after the wait Google named
   * or the next step of the backoff, and every write into the space waits with
   * it. Any other refusal is returned as `call` returns it.
   */
  private async write(what: string, target: string, space: string, path: string, init: RequestInit): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const sent = await this.writes.turn(space);
      try {
        return await this.call(what, target, path, init, sent);
      } catch (err) {
        if (!(err instanceof ChatApiError) || err.httpStatus !== 429) throw err;
        const wait = err.retryAfterMs ?? FIRST_RATE_LIMIT_WAIT_MS * 2 ** (attempt - 1);
        const fields = { what, target, space, attempt, waitMs: wait, retryAfterMs: err.retryAfterMs };
        if (attempt >= RATE_LIMIT_ATTEMPTS || wait > LONGEST_RATE_LIMIT_WAIT_MS) {
          logger.error(
            { ...fields, reason: err.message },
            "workspace-chat write refused for Google's rate limit, given up",
          );
          throw err;
        }
        logger.warn(fields, "workspace-chat write refused for Google's rate limit, sent again after the wait");
        this.writes.holdBack(space, wait);
      } finally {
        sent();
      }
    }
  }

  // One retry, on 401 only: that is the answer to a token Google no longer
  // accepts, and a fresh token is the whole remedy. Any other refusal is
  // returned to the caller, whose send queue owns retrying a delivery.
  // `sending` is called as the first request leaves, which is the moment a
  // write's turn is counted from.
  private async call(
    what: string,
    target: string,
    path: string,
    init: RequestInit,
    sending?: () => void,
  ): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const token = await this.accessToken();
      sending?.();
      const resp = await fetch(`${this.opts.apiRoot}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
      });
      if (resp.ok) return resp;
      if (resp.status === 401 && attempt === 1) {
        await resp.body?.cancel();
        this.token = undefined;
        continue;
      }
      const { status, reason } = await describeFailure(resp);
      throw new ChatApiError(
        `${what} on ${target} failed: HTTP ${resp.status} ${reason}`.trim(),
        resp.status,
        status,
        resp.status === 429 ? retryAfterMs(resp.headers.get("retry-after")) : undefined,
      );
    }
  }

  private async accessToken(): Promise<string> {
    const now = this.now();
    if (this.token && this.token.expiresAt - RENEW_MARGIN_MS > now) return this.token.value;

    const key = readServiceAccountKey(this.opts.keyPath);
    const iat = Math.floor(now / 1000);
    const header = { alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) };
    const claims = {
      iss: key.client_email,
      scope: CHAT_BOT_SCOPE,
      aud: key.token_uri,
      iat,
      exp: iat + ASSERTION_LIFETIME_SEC,
    };
    const unsigned = `${b64url(header)}.${b64url(claims)}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key).toString("base64url");

    const resp = await fetch(key.token_uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }).toString(),
    });
    if (!resp.ok) {
      const { status, reason } = await describeFailure(resp);
      throw new ChatApiError(
        `token exchange at ${key.token_uri} failed: HTTP ${resp.status} ${reason}`,
        resp.status,
        status,
      );
    }
    const body = (await resp.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      throw new ChatApiError(`token exchange at ${key.token_uri} returned no access_token`, resp.status, undefined);
    }
    this.token = { value: body.access_token, expiresAt: now + (body.expires_in ?? ASSERTION_LIFETIME_SEC) * 1000 };
    return body.access_token;
  }
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

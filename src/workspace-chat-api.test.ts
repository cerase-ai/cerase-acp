// The calls the Workspace Chat adapter makes to Google with the tenant's own
// service account: exchanging the key for an access token, posting a reply,
// finding a user's direct-message space, downloading an upload.
//
// Everything runs against fake Google endpoints on loopback. The token
// endpoint verifies the assertion's signature and claims, so a signer that
// produced the wrong audience or scope fails here rather than on a tenant's
// first message.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHAT_BOT_SCOPE,
  type FakeGoogle,
  makeServiceAccount,
  type ServiceAccount,
  startFakeGoogle,
  writeKeyFile,
} from "./__tests__/fake-google.js";
import { ChatApiError, googleEndpointProblem, readServiceAccountKey, WorkspaceChatApi } from "./workspace-chat-api.js";

describe("workspace-chat API: app authentication and the calls made with it", () => {
  let google: FakeGoogle;
  let account: ServiceAccount;
  let dir: string;
  let keyPath: string;
  let clock: number;

  beforeEach(async () => {
    google = await startFakeGoogle();
    account = makeServiceAccount();
    google.trust(account);
    dir = mkdtempSync(join(tmpdir(), "wc-api-"));
    keyPath = join(dir, "service-account.json");
    writeKeyFile(keyPath, account, google.tokenUri);
    clock = 1_800_000_000_000;
  });

  afterEach(async () => {
    await google.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const api = () => new WorkspaceChatApi({ keyPath, apiRoot: google.apiRoot, now: () => clock });

  it("a reply goes into the event's thread, authorised by a token issued to the service account for chat.bot", async () => {
    await api().createMessage("spaces/AAAA", "Ecco il riepilogo.", "spaces/AAAA/threads/T1");

    expect(google.posts).toEqual([
      {
        space: "spaces/AAAA",
        text: "Ecco il riepilogo.",
        thread: "spaces/AAAA/threads/T1",
        messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
        authorization: "Bearer access-token-1",
      },
    ]);
    const nowSec = Math.floor(clock / 1000);
    expect(google.assertions).toEqual([
      { iss: account.clientEmail, scope: CHAT_BOT_SCOPE, aud: google.tokenUri, iat: nowSec, exp: nowSec + 3600 },
    ]);
  });

  it("without a thread the reply goes to the space and asks for no reply option", async () => {
    await api().createMessage("spaces/AAAA", "Fatto.");
    expect(google.posts.map((p) => [p.space, p.thread, p.messageReplyOption])).toEqual([
      ["spaces/AAAA", undefined, null],
    ]);
  });

  // Google issues a token for an hour. Exchanging the key for every chunk of
  // every reply would put the token endpoint on the path of each message.
  it("one token serves every post until it is a minute from expiring, then exactly one new one is fetched", async () => {
    const client = api();
    await client.createMessage("spaces/AAAA", "uno");
    await client.createMessage("spaces/AAAA", "due");
    await client.createMessage("spaces/AAAA", "tre");
    expect(google.tokenRequests()).toBe(1);

    clock += 3599_000 - 59_000;
    await client.createMessage("spaces/AAAA", "quattro");
    expect(google.tokenRequests()).toBe(2);
    expect(google.posts.map((p) => p.authorization)).toEqual([
      "Bearer access-token-1",
      "Bearer access-token-1",
      "Bearer access-token-1",
      "Bearer access-token-2",
    ]);
  });

  it("a token the Chat API stops accepting is replaced once and the post goes through", async () => {
    const client = api();
    await client.createMessage("spaces/AAAA", "prima");
    google.revokeIssuedTokens();
    await client.createMessage("spaces/AAAA", "dopo");
    expect(google.tokenRequests()).toBe(2);
    expect(google.posts.map((p) => [p.text, p.authorization])).toEqual([
      ["prima", "Bearer access-token-1"],
      ["dopo", "Bearer access-token-2"],
    ]);
  });

  it("a 401 on the fresh token too is reported, not retried a third time", async () => {
    const unauthenticated = {
      error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" },
    };
    google.failNextPost(401, unauthenticated);
    google.failNextPost(401, unauthenticated);
    google.failNextPost(401, unauthenticated);
    const err = await api()
      .createMessage("spaces/AAAA", "risposta")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatApiError);
    expect((err as ChatApiError).httpStatus).toBe(401);
    expect(google.tokenRequests()).toBe(2);
    expect(google.posts).toEqual([]);
  });

  // The operator reads this line in the bridge's log with no other context:
  // which call, which space, what Google answered.
  it("a refused post raises an error naming the call, the space, the HTTP status and Google's own reason", async () => {
    google.failNextPost(403, {
      error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" },
    });
    const err = await api()
      .createMessage("spaces/AAAA", "risposta")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatApiError);
    const e = err as ChatApiError;
    expect([e.httpStatus, e.googleStatus]).toEqual([403, "PERMISSION_DENIED"]);
    expect(e.message).toBe(
      "spaces.messages.create on spaces/AAAA failed: HTTP 403 PERMISSION_DENIED: The caller does not have permission",
    );
  });

  it("a key the token endpoint refuses raises an error carrying the endpoint's reason", async () => {
    writeKeyFile(keyPath, makeServiceAccount(), google.tokenUri);
    const err = await api()
      .createMessage("spaces/AAAA", "risposta")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatApiError);
    expect((err as Error).message).toBe(
      `token exchange at ${google.tokenUri} failed: HTTP 400 invalid_grant: Invalid JWT Signature.`,
    );
    expect(google.posts).toEqual([]);
  });

  // The console replaces the key file in place. A key read once at start
  // would keep signing with the revoked one until the bridge restarted.
  it("the key is read again when a token is renewed, so a key replaced in the console is used without a restart", async () => {
    const client = api();
    await client.createMessage("spaces/AAAA", "prima");
    const rotated = makeServiceAccount("cerase-chat-rotated@tenant-project.iam.gserviceaccount.com");
    google.trust(rotated);
    writeKeyFile(keyPath, rotated, google.tokenUri);
    clock += 3600_000;
    await client.createMessage("spaces/AAAA", "dopo");
    expect(google.assertions.map((a) => a.iss)).toEqual([account.clientEmail, rotated.clientEmail]);
  });

  it("finds the direct-message space of a user by email", async () => {
    expect(await api().findDirectMessage("mario.rossi@example.com")).toBe("spaces/dm-mario-rossi-example-com");
    expect(google.dmLookups).toEqual(["users/mario.rossi@example.com"]);
  });

  it("downloads an uploaded attachment's bytes", async () => {
    const bytes = await api().downloadMedia("spaces/AAAA/attachments/X1");
    expect(bytes.toString("utf8")).toBe("bytes of spaces/AAAA/attachments/X1");
  });
});

describe("workspace-chat API: reading the service-account key", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wc-key-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a missing key names the path and the system's reason", () => {
    const path = join(dir, "absent.json");
    expect(() => readServiceAccountKey(path)).toThrow(
      `the Workspace Chat service-account key at ${path} cannot be read (ENOENT)`,
    );
  });

  it("a key that is not JSON names the path", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{ not json");
    expect(() => readServiceAccountKey(path)).toThrow(
      `the Workspace Chat service-account key at ${path} is not valid JSON`,
    );
  });

  it("a key without a private key or client email names what is missing", () => {
    const path = join(dir, "partial.json");
    writeFileSync(path, JSON.stringify({ type: "service_account", client_email: "" }));
    expect(() => readServiceAccountKey(path)).toThrow(
      `the Workspace Chat service-account key at ${path} has no client_email, private_key`,
    );
  });

  it("a key without token_uri uses Google's token endpoint", () => {
    const path = join(dir, "no-token-uri.json");
    const account = makeServiceAccount();
    writeFileSync(path, JSON.stringify({ client_email: account.clientEmail, private_key: account.privateKeyPem }));
    expect(readServiceAccountKey(path).token_uri).toBe("https://oauth2.googleapis.com/token");
  });
});

// The addresses of Google's endpoints can be written in the configuration so a
// test can serve them. Plaintext toward a dotted name would let a dropped letter
// in Google's own address hand the certificate fetch, and with it the signature
// check, to anybody on the path; a name without a dot or a loopback address is
// where a test's stand-in lives.
describe("workspace-chat: which configured Google endpoint addresses are accepted", () => {
  it.each([
    "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat%40system.gserviceaccount.com",
    "https://chat.googleapis.com",
    "http://fake-google:8080/certs",
    "http://localhost:4000",
    "http://127.0.0.1:4000/certs",
    "http://[::1]:4000",
  ])("%s is accepted", (value) => {
    expect(googleEndpointProblem("workspace_chat.certificates_url", value)).toBeUndefined();
  });

  it.each([
    "http://www.googleapis.com/service_accounts/v1/metadata/x509/chat%40system.gserviceaccount.com",
    "http://10.0.0.5:8080",
    "http://[2001:db8::1]:8080",
    "htps://www.googleapis.com/certs",
    "www.googleapis.com/certs",
    "file:///etc/cerase-acp/certs.json",
    "data:application/json,{}",
    "",
  ])("%j is refused, naming the key and the value", (value) => {
    expect(googleEndpointProblem("workspace_chat.certificates_url", value)).toBe(
      `workspace_chat.certificates_url must be an https URL, or an http URL to a host name without a dot or to a loopback address, and ${JSON.stringify(value)} is neither`,
    );
  });
});

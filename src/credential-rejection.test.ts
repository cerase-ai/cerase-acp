import { Client, fetchRecommendedShardCount, GatewayIntentBits } from "discord.js";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeDiscord } from "./__tests__/fake-discord.js";
import { classifyCredentialRejection } from "./credential-rejection.js";

/** A discord.js error as it reaches the supervisor: an Error carrying a `code`. */
function discordError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("classifyCredentialRejection", () => {
  it("classifies the token discord.js refuses at login", () => {
    const rejection = classifyCredentialRejection(discordError("TokenInvalid", "An invalid token was provided."));
    expect(rejection).toBeDefined();
    expect(rejection?.code).toBe("TokenInvalid");
    expect(rejection?.credential).toBe("bot_token");
    expect(rejection?.detail).toMatch(/bot_token/);
  });

  it("classifies a login attempted with no token at all", () => {
    const rejection = classifyCredentialRejection(
      discordError("TokenMissing", "Request to use token, but token was unavailable to the client."),
    );
    expect(rejection?.code).toBe("TokenMissing");
    expect(rejection?.credential).toBe("bot_token");
  });

  // The shape discord.js really raises: @discordjs/ws turns gateway close
  // 4014 into a bare Error with this message and no code, and login() rejects
  // with it unwrapped. The test against the installed library below pins it.
  it("classifies a privileged intent the application was never granted, as the library raises it", () => {
    const rejection = classifyCredentialRejection(new Error("Used disallowed intents"));
    expect(rejection).toEqual({
      code: "DisallowedIntents",
      credential: "bot_token",
      detail:
        "The Discord application behind this bot token is not granted the Message Content intent. Enable it in the developer portal, under Bot and then Privileged Gateway Intents.",
    });
  });

  it("classifies a token the gateway refused at identify, as the library raises it", () => {
    // Close 4004, raised by @discordjs/ws the same bare way as 4014.
    const rejection = classifyCredentialRejection(new Error("Authentication failed"));
    expect(rejection?.code).toBe("AuthenticationFailed");
    expect(rejection?.credential).toBe("bot_token");
    expect(rejection?.detail).toMatch(/bot_token/);
  });

  it("matches the library's sentence exactly, not anything that resembles it", () => {
    expect(classifyCredentialRejection(new Error("Used disallowed intents."))).toBeUndefined();
    expect(classifyCredentialRejection(new Error("used disallowed intents"))).toBeUndefined();
    expect(classifyCredentialRejection(new Error("Error: Used disallowed intents"))).toBeUndefined();
    // Only an Error carries the library's sentence; a bare object with the
    // same text is somebody else's.
    expect(classifyCredentialRejection({ message: "Used disallowed intents" })).toBeUndefined();
  });

  it("leaves the gateway's other uncoded refusals retryable", () => {
    // Close 4011 and 4013, raised by @discordjs/ws the same way as 4014.
    expect(classifyCredentialRejection(new Error("Sharding is required"))).toBeUndefined();
    expect(classifyCredentialRejection(new Error("Used invalid intents"))).toBeUndefined();
  });

  it("leaves a transport failure retryable", () => {
    expect(
      classifyCredentialRejection(discordError("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error")),
    ).toBeUndefined();
    expect(classifyCredentialRejection(discordError("ECONNRESET", "socket hang up"))).toBeUndefined();
    expect(classifyCredentialRejection(new Error("503 Service Unavailable"))).toBeUndefined();
  });

  it("leaves ShardingRequired retryable: it is a statement about scale, not about the credential", () => {
    expect(
      classifyCredentialRejection(discordError("ShardingRequired", "This session would have handled too many guilds")),
    ).toBeUndefined();
  });

  it("does not treat an inherited Object property name as a known code", () => {
    // A lookup table indexed by an attacker-influenced string returns
    // Object.prototype members unless the lookup is own-key only.
    expect(classifyCredentialRejection(discordError("toString", "nope"))).toBeUndefined();
    expect(classifyCredentialRejection(discordError("constructor", "nope"))).toBeUndefined();
  });

  it("ignores errors with no usable code", () => {
    expect(classifyCredentialRejection(undefined)).toBeUndefined();
    expect(classifyCredentialRejection(null)).toBeUndefined();
    expect(classifyCredentialRejection("TokenInvalid")).toBeUndefined();
    expect(classifyCredentialRejection({ code: 50035 })).toBeUndefined();
  });
});

/** What login() rejects with, or the resolved value if it does not reject. */
async function loginFailure(client: Client, token: string): Promise<unknown> {
  return client.login(token).then(
    (value) => ({ resolved: value }),
    (err: unknown) => err,
  );
}

// The table above is only as good as its agreement with the library. A
// hand-built error that discord.js never raises passed every test here while
// a real refusal went unrecognised, so these drive the installed discord.js
// and classify what it actually rejects with.
describe("classifyCredentialRejection against the installed discord.js", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  /** A client with the intents the Discord adapter asks for. */
  function adapterClient(api?: string): Client {
    const client = new Client({
      intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.Guilds],
      ...(api ? { rest: { api } } : {}),
    });
    cleanups.push(async () => {
      await client.destroy();
    });
    return client;
  }

  it("a gateway refusing a privileged intent (close 4014) rejects login() with a DisallowedIntents refusal", async () => {
    const discord = await startFakeDiscord({ identifyCloseCode: 4014 });
    cleanups.push(() => discord.close());

    const err = await loginFailure(adapterClient(discord.api), "a.bot.token");

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Used disallowed intents");
    expect(err).not.toHaveProperty("code");
    expect(classifyCredentialRejection(err)?.code).toBe("DisallowedIntents");
  });

  it("a gateway refusing the token at identify (close 4004) rejects login() with an AuthenticationFailed refusal", async () => {
    const discord = await startFakeDiscord({ identifyCloseCode: 4004 });
    cleanups.push(() => discord.close());

    const err = await loginFailure(adapterClient(discord.api), "a.bot.token");

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Authentication failed");
    expect(err).not.toHaveProperty("code");
    expect(classifyCredentialRejection(err)?.code).toBe("AuthenticationFailed");
  });

  it("a token the gateway lookup refuses rejects login() with TokenInvalid", async () => {
    const discord = await startFakeDiscord({ refuseToken: true });
    cleanups.push(() => discord.close());

    const err = await loginFailure(adapterClient(discord.api), "a.bot.token");

    expect(err).toHaveProperty("code", "TokenInvalid");
    expect(classifyCredentialRejection(err)?.code).toBe("TokenInvalid");
  });

  it("login() with an empty token rejects with TokenInvalid before contacting Discord", async () => {
    const err = await loginFailure(adapterClient(), "");

    expect(err).toHaveProperty("code", "TokenInvalid");
    expect(classifyCredentialRejection(err)?.code).toBe("TokenInvalid");
  });

  it("TokenMissing still arrives as an error carrying that code", async () => {
    const err = await fetchRecommendedShardCount("").then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toHaveProperty("code", "TokenMissing");
    expect(classifyCredentialRejection(err)?.code).toBe("TokenMissing");
  });
});

import { describe, expect, it } from "vitest";
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

  it("classifies a privileged intent the application was never granted", () => {
    const rejection = classifyCredentialRejection(
      discordError("DisallowedIntents", "Privileged intent provided is not enabled or whitelisted."),
    );
    expect(rejection?.code).toBe("DisallowedIntents");
    expect(rejection?.credential).toBe("bot_token");
    // The operator has to act in the Discord developer portal, not in
    // agents.yaml, so the detail must send them there.
    expect(rejection?.detail).toMatch(/portal/i);
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

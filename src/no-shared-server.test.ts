// Discord refuses a DM with 50278 «Cannot send messages to this user» when the
// bot shares no server with that person. On 21 October a tenant's assistant was
// in no server at all, so every DM failed that way, was retried three times,
// and the failure marker was sent to the same refused channel. Recognising the
// refusal is the one decision every other part of that fix is built on: it is a
// number on an error, and nothing else is.
//
// Names and ids are invented.

import { describe, expect, it } from "vitest";
import { isNoSharedServer } from "./no-shared-server.js";

const refusal = () => Object.assign(new Error("Cannot send messages to this user"), { code: 50278, status: 400 });

describe("isNoSharedServer", () => {
  it("recognises Discord's 50278 refusal", () => {
    expect(isNoSharedServer(refusal())).toBe(true);
  });

  it("does not treat another numeric code as the same refusal", () => {
    expect(isNoSharedServer(Object.assign(new Error("Missing Access"), { code: 50001 }))).toBe(false);
  });

  it("does not treat a plain Error as the refusal", () => {
    expect(isNoSharedServer(new Error("Cannot send messages to this user"))).toBe(false);
  });

  it("does not treat undefined as the refusal", () => {
    expect(isNoSharedServer(undefined)).toBe(false);
  });

  it("does not treat the code as a string as the refusal", () => {
    // discord.js raises the code as a number; a string that merely looks like
    // it belongs to something else and must not silence the retries.
    expect(isNoSharedServer(Object.assign(new Error("Cannot send messages to this user"), { code: "50278" }))).toBe(
      false,
    );
  });
});

// The control-plane sends one approval link for every action an assistant
// asked during a turn, and it can only do that once it hears the turn ended,
// with the identity of the person the turn was for. This file pins the request
// the bridge makes to say so.

import { describe, expect, it } from "vitest";
import { postTurnEnded } from "./turn-ended.js";

const OPTS = { controlPlaneUrl: "http://cp:8000/", internalSecret: "s3cret", bridgeSecret: "bridge-secret" };

function recordingFetch(status = 204): {
  fetchImpl: typeof fetch;
  seen: () => { url: string; init: RequestInit | undefined };
} {
  let url = "";
  let init: RequestInit | undefined;
  const fetchImpl = (async (u: string, i?: RequestInit) => {
    url = String(u);
    init = i;
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen: () => ({ url, init }) };
}

describe("postTurnEnded", () => {
  it("posts the agent and the person's channel identity to the control-plane", async () => {
    const { fetchImpl, seen } = recordingFetch();

    await postTurnEnded("agent/one", { platform: "discord", platformUserId: "12345" }, { ...OPTS, fetchImpl });

    const { url, init } = seen();
    // The agent id is part of the path, so a slash in it must not become one.
    expect(url).toBe("http://cp:8000/api/internal/turn-ended/agent%2Fone");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer s3cret");
    expect(headers.get("x-cerase-bridge-secret")).toBe("bridge-secret");
    expect(headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ platform: "discord", platform_user_id: "12345" });
  });

  it("leaves out a field the identity does not carry", async () => {
    const withoutPlatform = recordingFetch();
    await postTurnEnded("a", { platformUserId: "u" }, { ...OPTS, fetchImpl: withoutPlatform.fetchImpl });
    const noPlatform = JSON.parse(String(withoutPlatform.seen().init?.body));
    expect(noPlatform).toEqual({ platform_user_id: "u" });
    expect("platform" in noPlatform).toBe(false);

    const withoutUser = recordingFetch();
    await postTurnEnded("a", { platform: "discord" }, { ...OPTS, fetchImpl: withoutUser.fetchImpl });
    const noUser = JSON.parse(String(withoutUser.seen().init?.body));
    expect(noUser).toEqual({ platform: "discord" });
    expect("platform_user_id" in noUser).toBe(false);
  });

  it("rejects with the endpoint and status when the control-plane refuses the news", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

    await expect(postTurnEnded("a", {}, { ...OPTS, fetchImpl })).rejects.toThrow(/turn-ended.*500/);
  });
});

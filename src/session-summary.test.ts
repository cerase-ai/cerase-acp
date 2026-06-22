import { describe, expect, it } from "vitest";
import { postSessionSummary } from "./session-summary.js";

describe("postSessionSummary", () => {
  const opts = (fetchImpl: typeof fetch) => ({
    controlPlaneUrl: "http://cerase-control-plane:8000",
    internalSecret: "s",
    fetchImpl,
  });

  it("POSTs the trimmed summary with the bearer + JSON body, returns true on 2xx", async () => {
    let seenUrl = "";
    let seenAuth = "";
    let seenMethod = "";
    let seenBody = "";
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenMethod = init?.method ?? "";
      seenAuth = (init?.headers as Record<string, string>).Authorization;
      seenBody = init?.body as string;
      return { ok: true } as Response;
    }) as unknown as typeof fetch;

    const ok = await postSessionSummary("agent-1", "  ## Anchored Summary  ", opts(fakeFetch));

    expect(ok).toBe(true);
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://cerase-control-plane:8000/api/internal/session-summary");
    expect(seenAuth).toBe("Bearer s");
    expect(JSON.parse(seenBody)).toEqual({ agent_id: "agent-1", summary: "## Anchored Summary" });
  });

  it("does NOT call the endpoint on an empty/whitespace summary", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return { ok: true } as Response;
    }) as unknown as typeof fetch;

    expect(await postSessionSummary("agent-1", "   ", opts(fakeFetch))).toBe(false);
    expect(called).toBe(false);
  });

  it("does NOT call the endpoint when agentId is empty", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return { ok: true } as Response;
    }) as unknown as typeof fetch;

    expect(await postSessionSummary("", "x", opts(fakeFetch))).toBe(false);
    expect(called).toBe(false);
  });

  it("returns false on a non-ok response", async () => {
    const fakeFetch = (async () => ({ ok: false, status: 500 }) as Response) as unknown as typeof fetch;
    expect(await postSessionSummary("agent-1", "x", opts(fakeFetch))).toBe(false);
  });

  it("swallows a network error and returns false (never throws — capture is best-effort)", async () => {
    const fakeFetch = (async () => {
      throw new Error("control-plane down");
    }) as unknown as typeof fetch;

    await expect(postSessionSummary("agent-1", "x", opts(fakeFetch))).resolves.toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { applyApprovalLink, needsApprovalLink, fetchPendingApprovalLink } from "./approval-link.js";

const LINK = "https://cerase.example/approve/abc.def";

describe("applyApprovalLink", () => {
  it("replaces the placeholder with the link", () => {
    const out = applyApprovalLink("Per procedere approvi qui: {{APPROVAL_LINK}}", LINK);
    expect(out).toBe(`Per procedere approvi qui: ${LINK}`);
  });

  it("appends the link when there is no placeholder", () => {
    const out = applyApprovalLink("Devo inviare la mail.", LINK);
    expect(out).toBe(`Devo inviare la mail.\n\n👉 ${LINK}`);
  });

  it("strips the placeholder when there is no link (no raw {{...}} shown)", () => {
    const out = applyApprovalLink("Approvi qui: {{APPROVAL_LINK}}", null);
    expect(out).toBe("Approvi qui:");
    expect(out).not.toContain("{{APPROVAL_LINK}}");
  });

  it("leaves a plain message untouched when there is no link and no placeholder", () => {
    expect(applyApprovalLink("ciao", null)).toBe("ciao");
  });

  it("needsApprovalLink detects the placeholder", () => {
    expect(needsApprovalLink("x {{APPROVAL_LINK}} y")).toBe(true);
    expect(needsApprovalLink("no placeholder")).toBe(false);
  });
});

describe("fetchPendingApprovalLink", () => {
  const opts = (fetchImpl: typeof fetch) => ({
    controlPlaneUrl: "http://cerase-control-plane:8000",
    internalSecret: "s",
    fetchImpl,
  });

  it("returns the link from the control-plane + sends the bearer", async () => {
    let seenAuth = "";
    let seenUrl = "";
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenAuth = (init?.headers as Record<string, string>).Authorization;
      return { ok: true, json: async () => ({ approval_link: LINK }) } as Response;
    }) as unknown as typeof fetch;

    const link = await fetchPendingApprovalLink("agent-1", opts(fakeFetch));
    expect(link).toBe(LINK);
    expect(seenAuth).toBe("Bearer s");
    expect(seenUrl).toContain("/api/internal/approval-pending-link?agent_id=agent-1");
  });

  it("returns null when there is no pending approval", async () => {
    const fakeFetch = (async () => ({ ok: true, json: async () => ({ approval_link: null }) }) as Response) as unknown as typeof fetch;
    expect(await fetchPendingApprovalLink("a", opts(fakeFetch))).toBeNull();
  });

  it("returns null on an HTTP error or exception (never throws)", async () => {
    const errFetch = (async () => ({ ok: false, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    expect(await fetchPendingApprovalLink("a", opts(errFetch))).toBeNull();

    const throwFetch = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(await fetchPendingApprovalLink("a", opts(throwFetch))).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { checkTenantCredit } from "./credit-check.js";

// The bridge asks the control-plane before a turn whether the tenant still has
// credits. The route is internal, so the request carries the bearer and the
// bridge secret; 402 means exhausted, 200 means proceed, anything else throws
// so the dispatcher can fail open.

const OPTS = {
  controlPlaneUrl: "http://cerase-control-plane:8000/",
  internalSecret: "bearer-from-agents-yaml",
  bridgeSecret: "bridge-secret",
};

function recording(status: number) {
  const seen = { url: "", method: "", auth: "", bridge: "" };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.url = url;
    seen.method = init?.method ?? "";
    seen.auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
    seen.bridge = (init?.headers as Record<string, string> | undefined)?.["X-Cerase-Bridge-Secret"] ?? "";
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

describe("checkTenantCredit", () => {
  it("POSTs to the internal route with the bearer and the bridge secret", async () => {
    const { fetchImpl, seen } = recording(200);

    await checkTenantCredit("agent 1", { ...OPTS, fetchImpl });

    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("http://cerase-control-plane:8000/api/internal/credit-check/agent%201");
    expect(seen.auth).toBe("Bearer bearer-from-agents-yaml");
    expect(seen.bridge).toBe("bridge-secret");
  });

  it("reads 402 as exhausted and 200 as proceed", async () => {
    const exhausted = recording(402);
    const proceed = recording(200);

    await expect(checkTenantCredit("a", { ...OPTS, fetchImpl: exhausted.fetchImpl })).resolves.toEqual({
      exhausted: true,
    });
    await expect(checkTenantCredit("a", { ...OPTS, fetchImpl: proceed.fetchImpl })).resolves.toEqual({
      exhausted: false,
    });
  });

  it("throws on another status or a network error, so the dispatcher fails open", async () => {
    const refused = recording(500);
    await expect(checkTenantCredit("a", { ...OPTS, fetchImpl: refused.fetchImpl })).rejects.toThrow(/HTTP 500/);

    const broken = (async () => {
      throw new Error("control-plane down");
    }) as unknown as typeof fetch;
    await expect(checkTenantCredit("a", { ...OPTS, fetchImpl: broken })).rejects.toThrow();
  });
});

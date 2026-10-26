import { describe, expect, it } from "vitest";
import { type InjectOutcome, postInjectOutcome } from "./inject-outcome.js";

// A scheduled message's turn is detached, so its outcome is reported back to
// the control-plane over the internal channel. Best-effort like the summary
// capture: a reporting failure must never affect the turn, so the helper
// resolves to a boolean and never throws.

describe("postInjectOutcome", () => {
  const opts = (fetchImpl: typeof fetch) => ({
    controlPlaneUrl: "http://cerase-control-plane:8000/",
    internalSecret: "s",
    fetchImpl,
  });

  function recording(response: Partial<Response> = { ok: true, status: 200 }) {
    const seen = { url: "", method: "", auth: "", contentType: "", body: "" };
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.url = url;
      seen.method = init?.method ?? "";
      seen.auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
      seen.contentType = (init?.headers as Record<string, string> | undefined)?.["Content-Type"] ?? "";
      seen.body = (init?.body as string | undefined) ?? "";
      return response as Response;
    }) as unknown as typeof fetch;
    return { fetchImpl, seen };
  }

  it("POSTs the ref and outcome to the control-plane with the bearer and JSON", async () => {
    const { fetchImpl, seen } = recording();
    const outcome: InjectOutcome = { ok: false, error: "boom", notice: "riprova" };

    expect(await postInjectOutcome("scheduled-message:9f1c:3", outcome, opts(fetchImpl))).toBe(true);

    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("http://cerase-control-plane:8000/api/internal/inject-outcome");
    expect(seen.auth).toBe("Bearer s");
    expect(seen.contentType).toBe("application/json");
    expect(JSON.parse(seen.body)).toEqual({
      ref: "scheduled-message:9f1c:3",
      ok: false,
      error: "boom",
      notice: "riprova",
    });
  });

  it("leaves an absent error and notice out of the body", async () => {
    const { fetchImpl, seen } = recording();

    expect(await postInjectOutcome("ref-1", { ok: true }, opts(fetchImpl))).toBe(true);
    expect(JSON.parse(seen.body)).toEqual({ ref: "ref-1", ok: true });
  });

  it("resolves true on a 2xx, false on a 500, and false when the fetch throws", async () => {
    expect(await postInjectOutcome("ref-1", { ok: true }, opts(recording({ ok: true, status: 204 }).fetchImpl))).toBe(
      true,
    );
    expect(await postInjectOutcome("ref-1", { ok: true }, opts(recording({ ok: false, status: 500 }).fetchImpl))).toBe(
      false,
    );

    const down = (async () => {
      throw new Error("control-plane down");
    }) as unknown as typeof fetch;
    await expect(postInjectOutcome("ref-1", { ok: true }, opts(down))).resolves.toBe(false);
  });

  it("cuts an error longer than 1000 characters to 1000", async () => {
    const { fetchImpl, seen } = recording();

    expect(await postInjectOutcome("ref-1", { ok: false, error: "x".repeat(1500) }, opts(fetchImpl))).toBe(true);

    expect((JSON.parse(seen.body) as { error: string }).error).toHaveLength(1000);
  });
});

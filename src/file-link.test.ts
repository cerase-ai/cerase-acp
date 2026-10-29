import { describe, expect, it } from "vitest";
import { requestFileLink } from "./file-link.js";

// The bridge asks the control-plane for a link when the agent's channel cannot
// carry the file itself. The route is internal, so the request carries the
// control-plane bearer and a JSON body naming the agent and the workspace path;
// the answer is reshaped into the camelCase the bridge uses.

const CONTROL_PLANE = "http://control-plane.test:9999/";
const SECRET = "internal-secret";

const opts = (fetchImpl: typeof fetch) => ({
  controlPlaneUrl: CONTROL_PLANE,
  internalSecret: SECRET,
  fetchImpl,
});

const ANSWER = {
  url: `https://box.example.test/f/${"a".repeat(64)}`,
  expires_at: "2026-11-05T09:00:00+01:00",
  name: "offerta.pdf",
  size_bytes: 12,
};

function recording(answer: unknown, status = 201) {
  const seen = { url: "", method: "", auth: "", contentType: "", body: "" };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.url = url;
    seen.method = init?.method ?? "";
    seen.auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
    seen.contentType = (init?.headers as Record<string, string> | undefined)?.["Content-Type"] ?? "";
    seen.body = (init?.body as string | undefined) ?? "";
    return { ok: status >= 200 && status < 300, status, json: async () => answer } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

describe("requestFileLink", () => {
  it("POSTs the agent and the workspace path to the internal file-link route", async () => {
    const { fetchImpl, seen } = recording(ANSWER);

    await requestFileLink("agent-1", "outputs/offerta.pdf", opts(fetchImpl));

    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("http://control-plane.test:9999/api/internal/file-links");
    expect(seen.auth).toBe(`Bearer ${SECRET}`);
    expect(seen.contentType).toBe("application/json");
    expect(JSON.parse(seen.body)).toEqual({
      agent_id: "agent-1",
      path: "outputs/offerta.pdf",
    });
  });

  it("maps the answer's snake_case fields to the bridge's own names", async () => {
    const { fetchImpl } = recording(ANSWER);

    await expect(requestFileLink("agent-1", "outputs/offerta.pdf", opts(fetchImpl))).resolves.toEqual({
      url: ANSWER.url,
      name: "offerta.pdf",
      expiresAt: "2026-11-05T09:00:00+01:00",
      sizeBytes: 12,
    });
  });

  it("throws an Error naming the status and the refusal when the control-plane answers 422", async () => {
    const { fetchImpl } = recording({ error: "path not allowed" }, 422);

    const error = await requestFileLink("agent-1", "../secret.pdf", opts(fetchImpl)).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("422");
    expect((error as Error).message).toContain("path not allowed");
  });
});

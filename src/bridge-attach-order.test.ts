import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// The workspace read is the one thing that has to succeed for this to be about
// ordering at all. It is mocked in this file and nowhere else: the sibling
// attach suite depends on a REAL docker exec failing against a container that
// does not exist, and a module-wide mock would take that evidence away.
vi.mock("./workspace-files.js", () => ({
  readAgentWorkspaceFile: async (_container: string, relPath: string) => ({
    name: relPath.split("/").pop() ?? relPath,
    bytes: Buffer.from("not a real pdf"),
  }),
}));

import { type RunBridgeHandle, runBridge } from "./bridge.js";
import type { ChatAdapter } from "./chat-adapter.js";
import type { BridgeConfig } from "./config.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

// One sentence introducing one file, which is the shape every reply of this
// kind has.
const REPLY = "Certo, te lo rimando: [[attach: outputs/foto.png]]";

// The order the operator saw on Discord: the file appeared above the sentence
// that introduced it, so the reader met a bare attachment and then the
// explanation for it.
describe("a file arrives after the sentence that introduces it", () => {
  let handle: RunBridgeHandle | undefined;

  afterEach(async () => {
    if (handle) await handle.shutdown();
    handle = undefined;
    vi.unstubAllEnvs();
  });

  it("sends the text first and the upload second", async () => {
    const SECRET = "order-secret";
    vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
    vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");

    const cfg: BridgeConfig = {
      agents: [
        {
          id: "order-probe",
          bot_token: "irrelevant",
          allowed_users: ["111"],
          spawn: { command: "env", args: ["--", `FAKE_REPLY=${REPLY}`, "node", FAKE_CHILD] },
        },
      ],
      session: { idle_timeout_minutes: 60, max_concurrent: 16 },
    };

    // One list, both kinds of event, so the assertion is about their sequence
    // rather than about two counters that could each be right separately.
    const events: string[] = [];

    handle = await runBridge({
      config: cfg,
      bridgeE2eTest: false,
      createAdapter: async (agent) => {
        const a: ChatAdapter = {
          agentId: agent.id,
          async start() {},
          async stop() {},
          makeSendTarget: () => async (chunk: string) => {
            events.push(`text:${chunk}`);
            return { ok: true };
          },
          sendFile: async (_userId, file) => {
            events.push(`file:${file.name}`);
            return { ok: true };
          },
        };
        return a;
      },
    });

    const res = await fetch(`${handle.internalUrl}/internal/inject`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ agent_id: "order-probe", user_id: "111", text: "ciao", surface_in_chat: false }),
    });
    expect(res.status).toBe(202);

    await vi.waitFor(
      () => {
        expect(events.some((e) => e.startsWith("file:"))).toBe(true);
      },
      { timeout: 8000, interval: 50 },
    );

    const textAt = events.findIndex((e) => e.startsWith("text:"));
    const fileAt = events.findIndex((e) => e.startsWith("file:"));

    expect(textAt).toBeGreaterThanOrEqual(0);
    expect(fileAt).toBeGreaterThan(textAt);

    // The sentence keeps its words and loses the marker, which is a separate
    // property from the order and would otherwise be asserted nowhere here.
    expect(events[textAt]).toContain("Certo, te lo rimando:");
    expect(events[textAt]).not.toContain("[[attach:");
    expect(events[fileAt]).toBe("file:foto.png");
  });

  it("still uploads when the marker was the whole reply", async () => {
    // No text to put first, and the file must not be withheld for the lack of
    // it. This is the branch that returns early, so it needs its own case.
    const SECRET = "order-secret-2";
    vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
    vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");

    const cfg: BridgeConfig = {
      agents: [
        {
          id: "order-probe-bare",
          bot_token: "irrelevant",
          allowed_users: ["111"],
          spawn: {
            command: "env",
            args: ["--", "FAKE_REPLY=[[attach: outputs/foto.png]]", "node", FAKE_CHILD],
          },
        },
      ],
      session: { idle_timeout_minutes: 60, max_concurrent: 16 },
    };

    const events: string[] = [];
    handle = await runBridge({
      config: cfg,
      bridgeE2eTest: false,
      createAdapter: async (agent) => {
        const a: ChatAdapter = {
          agentId: agent.id,
          async start() {},
          async stop() {},
          makeSendTarget: () => async (chunk: string) => {
            events.push(`text:${chunk}`);
            return { ok: true };
          },
          sendFile: async (_userId, file) => {
            events.push(`file:${file.name}`);
            return { ok: true };
          },
        };
        return a;
      },
    });

    const res = await fetch(`${handle.internalUrl}/internal/inject`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ agent_id: "order-probe-bare", user_id: "111", text: "ciao", surface_in_chat: false }),
    });
    expect(res.status).toBe(202);

    await vi.waitFor(
      () => {
        expect(events.some((e) => e.startsWith("file:"))).toBe(true);
      },
      { timeout: 8000, interval: 50 },
    );
    expect(events.filter((e) => e.startsWith("text:"))).toEqual([]);
  });
});

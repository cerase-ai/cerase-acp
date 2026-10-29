import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// Every marker the send path meets names a file that exists, so what is under
// test is how the bridge gets it to the person: as an upload where the channel
// can carry one, as a control-plane link where it cannot.
vi.mock("./workspace-files.js", () => ({
  readAgentWorkspaceFile: async (_container: string, relPath: string) => ({
    name: relPath.split("/").pop() ?? relPath,
    bytes: Buffer.from("not a real pdf"),
  }),
}));

import { type RunBridgeHandle, runBridge } from "./bridge.js";
import type { ChatAdapter, DeliveryResult, OutgoingFile } from "./chat-adapter.js";
import type { BridgeConfig } from "./config.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

const CONTROL_PLANE = "http://control-plane.test:9999";
const CONTROL_PLANE_SECRET = "control-plane-secret";
const FILE_URL = `https://box.example.test/f/${"a".repeat(64)}`;
const EXPIRES_AT = "2026-11-05T09:00:00+01:00";
const REPLY = "Ecco l'offerta. [[attach: outputs/offerta.pdf]]";
const REPLY_TEXT = "Ecco l'offerta.";

interface LinkAnswer {
  status: number;
  body: unknown;
}

interface LinkCall {
  url: string;
  init?: RequestInit;
}

interface Run {
  events: string[];
  links: LinkCall[];
  status: () => Promise<{ succeeded: number; failed: number; in_flight: number }>;
}

interface ConverseOptions {
  /** Absent for a channel that has no way to upload a file at all. */
  sendFile?: (userId: string, file: OutgoingFile) => Promise<DeliveryResult>;
  /** What the fake channel says it can carry on a file. */
  captionLimit?: number;
  /** What the control-plane answers when asked for a link. */
  link: LinkAnswer;
}

/**
 * One message from the person, answered with REPLY by the fake child. The
 * adapter records `text:<text>` for a message and `file:<name>|caption:<text>`
 * for an upload, and the fake `fetch` records every request the bridge makes
 * for a link while leaving the bridge's own internal server calls alone.
 * Every other control-plane request is answered 404 on the spot: passed on to
 * the network, the lookup of the test host held the previous-conversation read
 * for its five-second timeout, and the turn with it.
 */
async function converse(id: string, opts: ConverseOptions, keep: (h: RunBridgeHandle) => void): Promise<Run> {
  const SECRET = `${id}-acp-secret`;
  vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
  vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");
  vi.stubEnv("CERASE_CONTROL_PLANE_URL", CONTROL_PLANE);
  vi.stubEnv("CERASE_INTERNAL_SECRET", CONTROL_PLANE_SECRET);

  const links: LinkCall[] = [];
  const realFetch = globalThis.fetch;
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/api/internal/file-links")) {
      links.push({ url, init });
      return new Response(JSON.stringify(opts.link.body), { status: opts.link.status });
    }
    if (url.startsWith(CONTROL_PLANE)) return new Response("{}", { status: 404 });
    return realFetch(input, init);
  }) as typeof fetch;
  vi.stubGlobal("fetch", fakeFetch);

  const cfg: BridgeConfig = {
    agents: [
      {
        id,
        channel: "discord",
        cwd: "/home/agent/cerase/workspace",
        mode: "cerase",
        bot_token: "irrelevant",
        allowed_users: ["111"],
        spawn: { command: "env", args: ["--", `FAKE_REPLY=${REPLY}`, "node", FAKE_CHILD] },
      },
    ],
    session: { idle_timeout_minutes: 60, max_concurrent: 16 },
  };

  const events: string[] = [];
  const adapter: ChatAdapter = {
    agentId: id,
    async start() {},
    async stop() {},
    ...(opts.captionLimit !== undefined ? { captionLimit: opts.captionLimit } : {}),
    makeSendTarget: () => async (chunk: string) => {
      events.push(`text:${chunk}`);
      return { ok: true };
    },
    ...(opts.sendFile !== undefined
      ? {
          sendFile: async (userId: string, file: OutgoingFile) => {
            const result = await opts.sendFile!(userId, file);
            events.push(`file:${file.name}|caption:${file.caption ?? ""}`);
            return result;
          },
        }
      : {}),
  };
  const handle = await runBridge({
    config: cfg,
    bridgeE2eTest: false,
    createAdapter: async () => adapter,
  });
  keep(handle);

  const res = await fetch(`${handle.internalUrl}/internal/inject`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ agent_id: id, user_id: "111", text: "ciao", surface_in_chat: false }),
  });
  expect(res.status).toBe(202);

  return {
    events,
    links,
    status: async () => {
      const s = await fetch(`${handle.internalUrl}/internal/status`, {
        headers: { authorization: `Bearer ${SECRET}` },
      });
      return ((await s.json()) as { inject: { succeeded: number; failed: number; in_flight: number } }).inject;
    },
  };
}

const ended = async (run: Run, outcome: "succeeded" | "failed") =>
  vi.waitFor(
    async () => {
      const s = await run.status();
      expect(s.in_flight).toBe(0);
      expect(s[outcome]).toBe(1);
    },
    { timeout: 8000, interval: 50 },
  );

const texts = (run: Run) => run.events.filter((e) => e.startsWith("text:")).map((e) => e.slice(5));
const files = (run: Run) => run.events.filter((e) => e.startsWith("file:"));

const LINK_ANSWER: LinkAnswer = {
  status: 201,
  body: {
    url: FILE_URL,
    expires_at: EXPIRES_AT,
    name: "offerta.pdf",
    size_bytes: 12,
  },
};

describe("a file the channel cannot carry reaches the person as a link", () => {
  let handle: RunBridgeHandle | undefined;

  afterEach(async () => {
    if (handle) await handle.shutdown();
    handle = undefined;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("asks the control-plane for a link when the adapter has no sendFile, and records no attach failure", async () => {
    const run = await converse("file-link-no-send", { link: LINK_ANSWER }, (h) => (handle = h));
    await ended(run, "succeeded");

    expect(run.links).toHaveLength(1);
    expect(run.links[0]!.url).toBe(`${CONTROL_PLANE}/api/internal/file-links`);
    expect(JSON.parse(String(run.links[0]!.init?.body))).toEqual({
      agent_id: "file-link-no-send",
      path: "outputs/offerta.pdf",
    });

    const sent = texts(run);
    expect(files(run)).toEqual([]);
    expect(sent.some((t) => t.includes(FILE_URL) && t.includes("che scade il 5 novembre"))).toBe(true);
    expect(sent.join("\n")).not.toContain("non posso mandare allegati");
    expect(sent.join("\n")).not.toContain("Non sono riuscita ad allegare");
  });

  it("takes the link path when sendFile answers linkInstead, keeping the caption it carried", async () => {
    const run = await converse(
      "file-link-send-refused",
      {
        captionLimit: 2000,
        sendFile: async () => ({
          ok: false,
          linkInstead: true,
          error: new Error("the channel cannot carry this file"),
        }),
        link: LINK_ANSWER,
      },
      (h) => (handle = h),
    );
    await ended(run, "succeeded");

    expect(run.links).toHaveLength(1);
    expect(files(run)).toEqual([`file:offerta.pdf|caption:${REPLY_TEXT}`]);
    const sent = texts(run);
    expect(sent).toContain(REPLY_TEXT);
    expect(sent.some((t) => t.includes(FILE_URL) && t.includes("che scade il 5 novembre"))).toBe(true);
    expect(sent.join("\n")).not.toContain("non posso mandare allegati");
    expect(sent.join("\n")).not.toContain("Non sono riuscita ad allegare");
  });

  it("tells the person the attachment failed and fails the turn when the link request is refused", async () => {
    const run = await converse(
      "file-link-refused",
      { link: { status: 422, body: { error: "path not allowed" } } },
      (h) => (handle = h),
    );
    await ended(run, "failed");

    expect(run.links.length).toBeGreaterThanOrEqual(1);
    expect(texts(run).join("\n")).toContain("Non sono riuscita ad allegare offerta.pdf");
    expect(texts(run).join("\n")).not.toContain("non posso mandare allegati");
  });
});

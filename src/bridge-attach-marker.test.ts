import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// Every path the send path asks for is answered with a file, so what decides
// whether one is sent is the marker alone. Mocked in this file, as in the
// attach-order suite and for the same reason: the sibling attach suite needs a
// real docker exec to fail.
const reads: string[] = [];
vi.mock("./workspace-files.js", () => ({
  readAgentWorkspaceFile: async (_container: string, relPath: string) => {
    reads.push(relPath);
    return { name: relPath.split("/").pop() ?? relPath, bytes: Buffer.from("not a real pdf") };
  },
}));

import { type RunBridgeHandle, runBridge } from "./bridge.js";
import type { ChatAdapter } from "./chat-adapter.js";
import type { BridgeConfig } from "./config.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

interface Run {
  events: string[];
  status: () => Promise<{ succeeded: number; failed: number; in_flight: number }>;
}

/** One message from the person, through the internal server, to an assistant whose reply streams in `pieces`. */
async function converse(id: string, pieces: string[], keep: (h: RunBridgeHandle) => void): Promise<Run> {
  const SECRET = `${id}-secret`;
  vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
  vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");
  const cfg: BridgeConfig = {
    agents: [
      {
        id,
        channel: "discord",
        cwd: "/home/agent/cerase/workspace",
        mode: "cerase",
        bot_token: "irrelevant",
        allowed_users: ["111"],
        spawn: { command: "env", args: ["--", `FAKE_PIECES=${JSON.stringify(pieces)}`, "node", FAKE_CHILD] },
      },
    ],
    session: { idle_timeout_minutes: 60, max_concurrent: 16 },
  };
  const events: string[] = [];
  const handle = await runBridge({
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
  keep(handle);
  const res = await fetch(`${handle.internalUrl}/internal/inject`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ agent_id: id, user_id: "111", text: "ciao", surface_in_chat: false }),
  });
  expect(res.status).toBe(202);
  return {
    events,
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
const files = (run: Run) => run.events.filter((e) => e.startsWith("file:")).map((e) => e.slice(5));

describe("a file arrives wherever its marker falls", () => {
  let handle: RunBridgeHandle | undefined;

  afterEach(async () => {
    if (handle) await handle.shutdown();
    handle = undefined;
    reads.length = 0;
    vi.unstubAllEnvs();
  });

  const SENTENCE =
    "Ho preparato il riepilogo di ottobre, con le ore per progetto, le note del cliente e le scadenze del mese, ";
  const HEAD = `${SENTENCE}${SENTENCE}come mi avevi chiesto per la riunione di lunedì.`;

  it("sends the file of a reply of 200 characters or more that ends on its marker, and no marker as text", async () => {
    // The buffer reaches 200 characters with the marker open, its last sentence
    // end the dot before the extension: the shape of the replies that showed
    // the marker as text.
    expect(HEAD.length).toBeGreaterThan(200);
    const run = await converse(
      "marker-long",
      [`${HEAD} [[attach: outputs/riepilogo-ottobre.`, "pdf]]"],
      (h) => (handle = h),
    );
    await ended(run, "succeeded");
    expect(files(run)).toEqual(["riepilogo-ottobre.pdf"]);
    expect(texts(run)).toEqual([HEAD]);
    for (const t of texts(run)) expect(t).not.toMatch(/\[\[|\]\]/);
  });

  it("removes a marker naming a path outside the workspace, tells the person, and does not close the turn as delivered", async () => {
    const run = await converse("marker-unsafe", ["Ecco il file. [[attach: /etc/passwd]]"], (h) => (handle = h));
    await ended(run, "failed");
    expect(reads).toEqual([]);
    expect(files(run)).toEqual([]);
    const chat = texts(run).join("\n");
    expect(chat).toMatch(/Non sono riuscita a recuperare passwd/);
    expect(chat).not.toMatch(/\[\[|\]\]|\/etc/);
  });

  it("removes a marker left open, tells the person, and does not close the turn as delivered", async () => {
    const run = await converse("marker-open", ["Ecco il report. [[attach: outputs/report."], (h) => (handle = h));
    await ended(run, "failed");
    expect(files(run)).toEqual([]);
    const chat = texts(run).join("\n");
    expect(chat).toMatch(/Non sono riuscita a recuperare report /);
    expect(chat).not.toMatch(/\[\[|\]\]|outputs/);
  });
});

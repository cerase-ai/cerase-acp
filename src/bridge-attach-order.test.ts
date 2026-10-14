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
import type { ChatAdapter, DeliveryResult, OutgoingFile } from "./chat-adapter.js";
import type { BridgeConfig } from "./config.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

// One sentence introducing one file, which is the shape every reply of this
// kind has.
const REPLY = "Certo, te lo rimando: [[attach: outputs/foto.png]]";

// What is left of REPLY once the marker is out: the caption the file is
// expected to carry instead of a message of its own.
const REPLY_TEXT = "Certo, te lo rimando:";

interface Run {
  events: string[];
}

interface ConverseOptions {
  /** The caption limit the fake channel declares; defaults to 2000, Discord's message content limit. */
  captionLimit?: number;
  /** Decides whether an upload succeeds; the default accepts every one. */
  sendFile?: (userId: string, file: OutgoingFile) => Promise<DeliveryResult>;
}

/**
 * One message from the person, through the internal server, to an assistant
 * whose fake child answers `reply` in one turn. The adapter records what it was
 * asked to carry: `text:<text>` for a message and `file:<name>|caption:<text>`
 * for an upload, caption and all, so a case can assert where the words went.
 * `opts.sendFile` decides whether the upload succeeds; its result is handed back
 * to the bridge unchanged. `opts.captionLimit` is what the fake channel says it
 * can carry on a file, and defaults to 2000, Discord's message content limit.
 */
async function converse(
  id: string,
  reply: string,
  opts: ConverseOptions,
  keep: (h: RunBridgeHandle) => void,
): Promise<Run> {
  const { captionLimit = 2000, sendFile = async () => ({ ok: true }) } = opts;
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
        spawn: { command: "env", args: ["--", `FAKE_REPLY=${reply}`, "node", FAKE_CHILD] },
      },
    ],
    session: { idle_timeout_minutes: 60, max_concurrent: 16 },
  };
  const events: string[] = [];
  const adapter: ChatAdapter = {
    agentId: id,
    async start() {},
    async stop() {},
    captionLimit,
    makeSendTarget: () => async (chunk: string) => {
      events.push(`text:${chunk}`);
      return { ok: true };
    },
    sendFile: async (userId: string, file: OutgoingFile) => {
      const result = await sendFile(userId, file);
      events.push(`file:${file.name}|caption:${file.caption ?? ""}`);
      return result;
    },
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
  return { events };
}

/** The uploads a run recorded, in order, each with the caption it carried. */
const files = (run: Run) => run.events.filter((e) => e.startsWith("file:"));

/** The messages a run recorded, in order, the marker already stripped. */
const texts = (run: Run) => run.events.filter((e) => e.startsWith("text:")).map((e) => e.slice(5));

/** Waits until the run has recorded `count` uploads, so a case reads a settled list. */
const uploaded = (run: Run, count = 1) =>
  vi.waitFor(
    () => {
      expect(files(run).length).toBeGreaterThanOrEqual(count);
    },
    { timeout: 8000, interval: 50 },
  );

/** Waits until the run has recorded a message matching `pattern`, a failure notice being a message too. */
const told = (run: Run, pattern: RegExp) =>
  vi.waitFor(
    () => {
      expect(texts(run).some((t) => pattern.test(t))).toBe(true);
    },
    { timeout: 8000, interval: 50 },
  );

describe("a file travels with the sentence that introduces it", () => {
  let handle: RunBridgeHandle | undefined;

  afterEach(async () => {
    if (handle) await handle.shutdown();
    handle = undefined;
    vi.unstubAllEnvs();
  });

  it("carries the introducing sentence as the caption of the one file message, with no text of its own", async () => {
    // The reply of the operator's screenshot: a sentence, then the marker for
    // the file it talks about. The person must meet the words and the file
    // together, so the sentence rides as the caption of the single upload
    // rather than arriving as a message with a bare attachment after it.
    const run = await converse("caption-one", REPLY, {}, (h) => (handle = h));
    await uploaded(run);
    expect(files(run)).toEqual([`file:foto.png|caption:${REPLY_TEXT}`]);
    expect(texts(run)).toEqual([]);
  });

  it("carries a whole paragraph of prose that ends on its marker as the file's caption", async () => {
    // The reply that opened the report on Discord: one paragraph of Italian,
    // its full stop, and then its marker on the default streaming. The full stop
    // is where a sentence-boundary flush used to send the paragraph, leaving the
    // marker to arrive alone; the buffer now holds the sentence for the marker,
    // so the caption is the paragraph with the marker gone, whole, and nothing
    // of it goes out as text before.
    const paragraph =
      "Ho preparato il riepilogo di ottobre con le ore per progetto, le note del cliente e le scadenze del mese, " +
      "e l'ho ricontrollato voce per voce prima della riunione di lunedì, così da poter rispondere a ogni domanda " +
      "del team con i numeri aggiornati e le differenze rispetto al mese scorso, e adesso te lo mando come allegato.";
    const run = await converse(
      "caption-paragraph",
      `${paragraph} [[attach: outputs/prova-cerase-allegato.pdf]]`,
      {},
      (h) => (handle = h),
    );
    await uploaded(run);
    expect(files(run)).toEqual([`file:prova-cerase-allegato.pdf|caption:${paragraph}`]);
    expect(texts(run)).toEqual([]);
  });

  it("captions the last chunk of a long reply, after the text that came before it", async () => {
    // The decision is per chunk and never across chunks: the bridge must not
    // need to know what it sent before. A long reply with full stops is cut by
    // the stream buffer into several chunks, and the last one carries the marker
    // and is short enough to be a caption, so the file arrives with the sentence
    // that introduces it rather than bare after the rest of the text. It runs on
    // the fake child's default streaming, the cut the bridge really sees.
    const sentence = "Questa è una frase di prova abbastanza lunga da superare il limite dei duemila caratteri. ";
    const run = await converse(
      "caption-long",
      `${sentence.repeat(28)}[[attach: outputs/prova.pdf]]`,
      {},
      (h) => (handle = h),
    );
    await uploaded(run);
    const textEvents = run.events.filter((e) => e.startsWith("text:"));
    const fileEvents = files(run);
    expect(textEvents.length).toBeGreaterThan(0);
    expect(fileEvents).toHaveLength(1);
    const fileAt = run.events.findIndex((e) => e.startsWith("file:"));
    // The file is never bare: the chunk that carried the marker rode it as its
    // caption, holding the reply's last words before the marker, and no text
    // follows it.
    const caption = fileEvents[0]!.slice("file:prova.pdf|caption:".length);
    expect(caption).toContain("duemila caratteri.");
    expect(run.events.slice(fileAt + 1).filter((e) => e.startsWith("text:"))).toEqual([]);
  });

  it("sends the text first and the file bare when the text is longer than the channel's caption limit", async () => {
    // A one-chunk reply of about 120 characters with no full stop, on a channel
    // whose caption limit is 50: the text cannot ride the file, so it goes as
    // its own message and the bare upload follows, the order the original case
    // protected.
    const reply =
      "Certo, te lo rimando adesso con tutti i dettagli e le scadenze che servono per il cliente [[attach: outputs/foto.png]]";
    const run = await converse("caption-limit", reply, { captionLimit: 50 }, (h) => (handle = h));
    await uploaded(run);
    const textAt = run.events.findIndex((e) => e.startsWith("text:"));
    const fileAt = run.events.findIndex((e) => e.startsWith("file:"));
    expect(textAt).toBeGreaterThanOrEqual(0);
    expect(fileAt).toBeGreaterThan(textAt);
    expect(run.events[fileAt]).toBe("file:foto.png|caption:");
  });

  it("captions the first file only when the reply names two", async () => {
    // Two markers, one sentence introducing both. Only the first file can carry
    // the sentence as its caption; a caption on the second would repeat the
    // text under a file the sentence already introduced, so it stays bare.
    const run = await converse(
      "caption-two",
      "Ecco i due file: [[attach: outputs/foto.png]] [[attach: outputs/report.pdf]]",
      {},
      (h) => (handle = h),
    );
    await uploaded(run, 2);
    expect(files(run)).toEqual(["file:foto.png|caption:Ecco i due file:", "file:report.pdf|caption:"]);
    expect(texts(run)).toEqual([]);
  });

  it("still delivers the text and the failure notice when the captioned upload is refused", async () => {
    // The upload carries the sentence, so a refused upload would take the words
    // with it. The person must still read the sentence through the send target
    // AND be told the file did not arrive, as they were before captions existed.
    const run = await converse(
      "caption-refused",
      REPLY,
      { sendFile: async () => ({ ok: false, error: new Error("the channel refused the upload") }) },
      (h) => (handle = h),
    );
    await told(run, /Non sono riuscita ad allegare foto\.png/);
    expect(files(run)).toEqual([`file:foto.png|caption:${REPLY_TEXT}`]);
    expect(texts(run)).toContain(REPLY_TEXT);
    expect(texts(run).some((t) => /Non sono riuscita ad allegare foto\.png/.test(t))).toBe(true);
  });

  it("keeps the reply with its file while the channel is down, and captions it when the channel returns", async () => {
    // The keep decision is taken on the chunk as it was written, marker and all,
    // before any send: a reply the channel cannot carry waits, and the file is
    // read and uploaded only when the channel is back. The caption path must not
    // change that, so a kept reply still arrives whole, its sentence and its
    // file in one message, when the channel returns.
    vi.stubEnv("CERASE_ACP_KEPT_REPLY_POLL_MS", "50");
    const SECRET = "caption-kept-secret";
    vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
    vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");
    const cfg: BridgeConfig = {
      agents: [
        {
          id: "caption-kept",
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
    let up = true;
    const events: string[] = [];
    const adapter: ChatAdapter = {
      agentId: "caption-kept",
      async start() {
        up = true;
      },
      async stop() {
        up = false;
      },
      ready: () => up,
      captionLimit: 2000,
      makeSendTarget: () => async (chunk: string) => {
        if (!up) return { ok: false, error: new Error("the channel is down") };
        events.push(`text:${chunk}`);
        return { ok: true };
      },
      sendFile: async (_userId, file) => {
        if (!up) return { ok: false, error: new Error("the channel is down") };
        events.push(`file:${file.name}|caption:${file.caption ?? ""}`);
        return { ok: true };
      },
    };
    handle = await runBridge({ config: cfg, bridgeE2eTest: false, createAdapter: async () => adapter });
    up = false;
    const res = await fetch(`${handle.internalUrl}/internal/inject`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ agent_id: "caption-kept", user_id: "111", text: "ciao", surface_in_chat: false }),
    });
    expect(res.status).toBe(202);
    // The turn ends with the reply kept: nothing reached the person while the
    // channel was down.
    await vi.waitFor(
      async () => {
        const s = await fetch(`${handle!.internalUrl}/internal/status`, {
          headers: { authorization: `Bearer ${SECRET}` },
        });
        const body = (await s.json()) as { inject: { in_flight: number } };
        expect(body.inject.in_flight).toBe(0);
      },
      { timeout: 8000, interval: 50 },
    );
    expect(events).toEqual([]);
    up = true;
    await uploaded({ events });
    expect(files({ events })).toEqual([`file:foto.png|caption:${REPLY_TEXT}`]);
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
          channel: "discord",
          cwd: "/home/agent/cerase/workspace",
          mode: "cerase",
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

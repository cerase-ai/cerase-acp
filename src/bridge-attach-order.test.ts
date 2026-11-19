import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// The workspace read is the one thing that has to succeed for this to be about
// ordering at all. It is mocked in this file and nowhere else: the sibling
// attach suite depends on a REAL docker exec failing against a container that
// does not exist, and a module-wide mock would take that evidence away.
vi.mock("./workspace-files.js", () => ({
  readAgentWorkspaceFile: async (_container: string, relPath: string) => {
    const name = relPath.split("/").pop() ?? relPath;
    // A name that says the file is missing stands for the non-zero exit a real
    // `docker exec cat` answers with: the read throws, and the bridge must
    // still carry the words that introduced the file. Every other path reads,
    // so the ordering cases keep the file they need.
    if (name.includes("mancante")) throw new Error(`docker exec failed: no such file ${relPath}`);
    return { name, bytes: Buffer.from("not a real pdf") };
  },
}));

import { type RunBridgeHandle, runBridge } from "./bridge.js";
import type { ChatAdapter, DeliveryResult, OutgoingFile } from "./chat-adapter.js";
import type { BridgeConfig } from "./config.js";
import { specTest } from "./test-support/spec-rows.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

// One sentence introducing one file, which is the shape every reply of this
// kind has.
const REPLY = "Certo, te lo rimando: [[attach: outputs/foto.png]]";

// What is left of REPLY once the marker is out: the caption the file is
// expected to carry instead of a message of its own.
const REPLY_TEXT = "Certo, te lo rimando:";

// A short sentence that fits any caption limit, so the caption path is the one
// the cases below exercise.
const INTRO = "Certo, te lo mando subito:";

interface Run {
  events: string[];
}

interface ConverseOptions {
  /**
   * The caption limit the fake channel declares; defaults to 2000, Discord's
   * message content limit. `null` stands for a channel that declares none.
   */
  captionLimit?: number | null;
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
 * can carry on a file, and defaults to 2000, Discord's message content limit;
 * `null` declares no limit at all.
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
    captionLimit: captionLimit ?? undefined,
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

  specTest(
    "ACP-REPLY-023",
    "carries the introducing sentence as the caption of the one file message, with no text of its own",
    async (row) => {
      // The reply of the operator's screenshot: a sentence, then the marker for
      // the file it talks about. The person must meet the words and the file
      // together, so the sentence rides as the caption of the single upload
      // rather than arriving as a message with a bare attachment after it.
      const fileName = row.quoted("when")[0]!;
      const marker = `[[attach: outputs/${fileName}]]`;
      const reply = `Certo, te lo rimando: ${marker}`;
      const replyText = reply.replace(marker, "").trim();
      const run = await converse("caption-one", reply, {}, (h) => (handle = h));
      await uploaded(run);
      expect(files(run)).toEqual([`file:${fileName}|caption:${replyText}`]);
      expect(texts(run)).toEqual([]);

      const [fileEvent = ""] = files(run);
      const caption = fileEvent.slice(fileEvent.indexOf("|caption:") + "|caption:".length);
      const single = files(run).length === 1;
      const sentenceAsCaption = caption === replyText;
      const noText = texts(run).length === 0;
      const observed = `the sentence ${sentenceAsCaption ? `travels as the caption of the ${single ? "single upload" : "uploads"}` : "does not travel as the caption"} and ${noText ? "no text message is sent" : "a text message is sent"}`;
      expect(observed).toBe(row.expect);
    },
  );

  specTest(
    "ACP-REPLY-022",
    "carries a whole paragraph of prose that ends on its marker as the file's caption",
    async (row) => {
      // The reply that opened the report on Discord: one paragraph of Italian,
      // its full stop, and then its marker on the default streaming. The full stop
      // is where a sentence-boundary flush used to send the paragraph, leaving the
      // marker to arrive alone; the buffer now holds the sentence for the marker,
      // so the caption is the paragraph with the marker gone, whole, and nothing
      // of it goes out as text before.
      const marker = row.quoted("when")[0]!;
      const fileName = marker.slice(marker.lastIndexOf("/") + 1, -2);
      const paragraph =
        "Ho preparato il riepilogo di ottobre con le ore per progetto, le note del cliente e le scadenze del mese, " +
        "e l'ho ricontrollato voce per voce prima della riunione di lunedì, così da poter rispondere a ogni domanda " +
        "del team con i numeri aggiornati e le differenze rispetto al mese scorso, e adesso te lo mando come allegato.";
      const run = await converse("caption-paragraph", `${paragraph} ${marker}`, {}, (h) => (handle = h));
      await uploaded(run);
      expect(files(run)).toEqual([`file:${fileName}|caption:${paragraph}`]);
      expect(texts(run)).toEqual([]);

      const [fileEvent = ""] = files(run);
      const caption = fileEvent.slice(fileEvent.indexOf("|caption:") + "|caption:".length);
      const oneMessage = files(run).length === 1;
      const carriesFile = fileEvent.startsWith(`file:${fileName}|`);
      const paragraphAsCaption = caption === paragraph;
      const noTextBefore = texts(run).length === 0;
      const observed = `the person receives ${oneMessage ? "one message" : `${files(run).length} messages`} carrying ${carriesFile ? fileName : "no file"}${paragraphAsCaption ? " with the paragraph as its caption" : " without the paragraph as its caption"}, and ${noTextBefore ? "no text message before it" : "a text message before it"}`;
      expect(observed).toBe(row.expect);
    },
  );

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

  specTest(
    "ACP-REPLY-024",
    "sends the text first and the file bare when the text is longer than the channel's caption limit",
    async (row) => {
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

      const textFirst = textAt >= 0 && fileAt > textAt;
      const bare = run.events[fileAt]?.endsWith("|caption:") ?? false;
      const observed = `the text is sent ${textFirst ? "first" : "after the file"} and the file is sent ${bare ? "bare" : "with a caption"}`;
      expect(observed).toBe(row.expect);
    },
  );

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

  specTest(
    "ACP-REPLY-025",
    "keeps the reply with its file while the channel is down, and captions it when the channel returns",
    async (row) => {
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
      const kept = events.length === 0;
      up = true;
      await uploaded({ events });
      expect(files({ events })).toEqual([`file:foto.png|caption:${REPLY_TEXT}`]);

      const [fileEvent = ""] = files({ events });
      const caption = fileEvent.slice(fileEvent.indexOf("|caption:") + "|caption:".length);
      const captioned = files({ events }).length === 1 && caption === REPLY_TEXT;
      const observed = `the reply is ${kept ? "kept with its file" : "not kept with its file"} and is sent ${captioned ? "captioned" : "bare"} when the channel returns`;
      expect(observed).toBe(row.expect);
    },
  );

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

describe("a sentence that introduces a file the bridge cannot deliver", () => {
  let handle: RunBridgeHandle | undefined;

  afterEach(async () => {
    if (handle) await handle.shutdown();
    handle = undefined;
    vi.unstubAllEnvs();
  });

  /** How many times `sentence` reached the person, as a message or as a caption. */
  const copiesOf = (run: Run, sentence: string): number =>
    texts(run).filter((t) => t === sentence).length +
    files(run).filter((e) => e.endsWith(`|caption:${sentence}`)).length;

  /** Where the sentence as its own message and the failure notice sit in the run, in order. */
  const order = (run: Run, sentence: string) => ({
    sentenceAt: run.events.indexOf(`text:${sentence}`),
    noticeAt: run.events.findIndex((e) => e.startsWith("text:") && /Non sono riuscita a recuperare/.test(e)),
  });

  specTest("ACP-REPLY-026", "sends the sentence before the notice when the only file cannot be read", async (row) => {
    // The caption path used to leave the words inside a file that never left
    // the workspace: the read threw and only the notice went out. The person
    // must read the sentence first, once, and the failed upload must not add
    // a file event.
    const fileName = row.quoted("when")[0]!;
    const run = await converse(
      "caption-unreadable",
      `${INTRO} [[attach: outputs/${fileName}]]`,
      {},
      (h) => (handle = h),
    );
    await told(run, /Non sono riuscita a recuperare/);

    const copies = copiesOf(run, INTRO);
    const { sentenceAt, noticeAt } = order(run, INTRO);
    expect(copies).toBe(1);
    expect(sentenceAt).toBeGreaterThanOrEqual(0);
    expect(noticeAt).toBeGreaterThan(sentenceAt);
    expect(files(run).some((e) => e.endsWith(`|caption:${INTRO}`))).toBe(false);
    expect(files(run)).toEqual([]);

    const once = copies === 1;
    const before = sentenceAt >= 0 && noticeAt > sentenceAt;
    const noFile = files(run).length === 0;
    const observed = `the sentence is sent ${once ? "once" : `${copies} times`} as its own message ${before ? "before" : "after"} the notice that the file could not be retrieved, and ${noFile ? "no file is uploaded" : `${files(run).length} files are uploaded`}`;
    expect(observed).toBe(row.expect);
  });

  specTest(
    "ACP-REPLY-027",
    "sends the sentence before the notice when the marker names a path outside the workspace",
    async (row) => {
      // A refused marker never reaches a file read, so the sentence goes out as
      // text and the notice follows it. This is the order the caption path must
      // preserve when no file can carry the words.
      const marker = row.quoted("when")[0]!;
      const run = await converse("caption-outside", `${INTRO} ${marker}`, {}, (h) => (handle = h));
      await told(run, /Non sono riuscita a recuperare/);

      const copies = copiesOf(run, INTRO);
      const { sentenceAt, noticeAt } = order(run, INTRO);
      expect(copies).toBe(1);
      expect(sentenceAt).toBeGreaterThanOrEqual(0);
      expect(noticeAt).toBeGreaterThan(sentenceAt);
      expect(files(run).some((e) => e.endsWith(`|caption:${INTRO}`))).toBe(false);
      expect(files(run)).toEqual([]);

      const once = copies === 1;
      const before = sentenceAt >= 0 && noticeAt > sentenceAt;
      const noFile = files(run).length === 0;
      const observed = `the sentence is sent ${once ? "once" : `${copies} times`} as its own message ${before ? "before" : "after"} the notice that the file could not be retrieved, and ${noFile ? "no file is uploaded" : `${files(run).length} files are uploaded`}`;
      expect(observed).toBe(row.expect);
    },
  );

  specTest(
    "ACP-REPLY-028",
    "sends the sentence before the notice and leaves the readable second file bare",
    async (row) => {
      // The first file cannot carry the caption, and the second may not take it:
      // a caption on the second would put the words under a file they did not
      // introduce. The sentence therefore goes out alone, before the notice,
      // exactly once, and foto.png follows without one.
      const [missing, readable] = row.quoted("when");
      const run = await converse(
        "caption-mixed",
        `${INTRO} [[attach: outputs/${missing}]] [[attach: outputs/${readable}]]`,
        {},
        (h) => (handle = h),
      );
      await told(run, /Non sono riuscita a recuperare/);
      await uploaded(run);

      const copies = copiesOf(run, INTRO);
      const { sentenceAt, noticeAt } = order(run, INTRO);
      const fileEvents = files(run);
      expect(copies).toBe(1);
      expect(sentenceAt).toBeGreaterThanOrEqual(0);
      expect(noticeAt).toBeGreaterThan(sentenceAt);
      expect(fileEvents).toEqual([`file:${readable}|caption:`]);

      const once = copies === 1;
      const before = sentenceAt >= 0 && noticeAt > sentenceAt;
      const bareSecond = fileEvents.length === 1 && fileEvents[0] === `file:${readable}|caption:`;
      const observed = `the sentence is sent ${once ? "alone" : `${copies} times`} ${before ? "before" : "after"} the notice, and ${bareSecond ? `"${readable}" is uploaded with no caption` : `"${readable}" is not uploaded bare`}, so the sentence arrives ${once ? "once" : `${copies} times`}`;
      expect(observed).toBe(row.expect);
    },
  );

  it("sends the sentence as a message before the notice when the channel has no caption limit", async () => {
    // Without a caption limit the sentence never rides the file, so the older
    // order is the only one: text first, then the failure notice. A missing
    // file must not change it.
    const run = await converse(
      "caption-no-limit",
      `${INTRO} [[attach: outputs/mancante.pdf]]`,
      { captionLimit: null },
      (h) => (handle = h),
    );
    await told(run, /Non sono riuscita a recuperare/);

    const { sentenceAt, noticeAt } = order(run, INTRO);
    expect(sentenceAt).toBeGreaterThanOrEqual(0);
    expect(noticeAt).toBeGreaterThan(sentenceAt);
    expect(copiesOf(run, INTRO)).toBe(1);
    expect(files(run)).toEqual([]);
  });

  it("puts the sentence on a readable file's caption and never also as a message", async () => {
    // The ordinary caption path: the first file carries the words, so a text
    // event with the same words would repeat them.
    const run = await converse("caption-readable", `${INTRO} [[attach: outputs/foto.png]]`, {}, (h) => (handle = h));
    await uploaded(run);

    expect(files(run)).toEqual([`file:foto.png|caption:${INTRO}`]);
    expect(texts(run)).toEqual([]);
  });
});

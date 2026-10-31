import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type RunBridgeHandle, runBridge } from "./bridge.js";
import type { ChatAdapter } from "./chat-adapter.js";
import type { BridgeConfig } from "./config.js";

// A person can send a voice message instead of typing. The adapter stores it as
// an upload and the message carries only the `[Uploaded files: …]` marker, so
// without help the assistant receives a path it cannot hear. The bridge asks
// the control-plane to transcribe the audio after the credit gate and before
// the prompt is built, and the turn opens with the words; a transcription that
// fails leaves the turn exactly as it was.
//
// The fixture child plays the slot. FAKE_PROMPT_LOG records the prompt each
// session/prompt carried, which is what says what the assistant was told.

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

const CONTROL_PLANE = "http://control-plane.test:9999";
const CONTROL_PLANE_SECRET = "control-plane-secret";
const REPLY = "Ricevuto.";
const VOICE_MESSAGE = "[Uploaded files: uploads/1-0/voice.ogg]";
const TRANSCRIPT = "Ciao Matilde, mi prepari la bozza dell'offerta?";

interface TranscriptAnswer {
  status: number;
  body: unknown;
}

interface TranscriptCall {
  url: string;
  init?: RequestInit;
  body: { agent_id?: string; path?: string };
}

interface Run {
  events: string[];
  transcripts: TranscriptCall[];
  /** The last prompt the assistant was sent, or undefined when it was sent none. */
  prompt: () => string | undefined;
  status: () => Promise<{ succeeded: number; failed: number; in_flight: number }>;
}

interface ConverseOptions {
  /** What the control-plane answers for an audio path; the default answer carries no text. */
  transcripts?: TranscriptAnswer | ((path: string) => TranscriptAnswer);
  /** The credit gate's answer. 200 unless a test says otherwise. */
  creditStatus?: number;
}

const dirs: string[] = [];

/**
 * One message from the person, answered with REPLY by the fake child. The fake
 * `fetch` answers the transcript and credit routes and records every transcript
 * request; every other control-plane request is answered 404 on the spot, so a
 * lookup the test does not care about cannot hold the turn for its timeout.
 */
async function converse(
  id: string,
  text: string,
  opts: ConverseOptions,
  keep: (h: RunBridgeHandle) => void,
): Promise<Run> {
  const SECRET = `${id}-acp-secret`;
  vi.stubEnv("CERASE_ACP_INTERNAL_SECRET", SECRET);
  vi.stubEnv("CERASE_ACP_INTERNAL_PORT", "0");
  vi.stubEnv("CERASE_CONTROL_PLANE_URL", CONTROL_PLANE);
  vi.stubEnv("CERASE_INTERNAL_SECRET", CONTROL_PLANE_SECRET);

  const dir = mkdtempSync(join(tmpdir(), "bridge-voice-"));
  dirs.push(dir);
  const promptLog = join(dir, "prompts.log");

  const transcriptAnswer = opts.transcripts ?? { status: 200, body: { text: "" } };
  const transcripts: TranscriptCall[] = [];
  const realFetch = globalThis.fetch;
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/api/internal/voice-transcripts")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { agent_id?: string; path?: string };
      transcripts.push({ url, init, body });
      const answer = typeof transcriptAnswer === "function" ? transcriptAnswer(body.path ?? "") : transcriptAnswer;
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }
    if (url.includes("/api/internal/credit-check/")) {
      return new Response("{}", { status: opts.creditStatus ?? 200 });
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
        spawn: {
          command: "env",
          args: ["--", `FAKE_REPLY=${REPLY}`, `FAKE_PROMPT_LOG=${promptLog}`, "node", FAKE_CHILD],
        },
      },
    ],
    session: { idle_timeout_minutes: 60, max_concurrent: 16 },
  };

  const events: string[] = [];
  const adapter: ChatAdapter = {
    agentId: id,
    async start() {},
    async stop() {},
    makeSendTarget: () => async (chunk: string) => {
      events.push(`text:${chunk}`);
      return { ok: true };
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
    body: JSON.stringify({ agent_id: id, user_id: "111", text, surface_in_chat: false }),
  });
  expect(res.status).toBe(202);

  return {
    events,
    transcripts,
    prompt: () => {
      if (!existsSync(promptLog)) return undefined;
      const lines = readFileSync(promptLog, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      const last = lines[lines.length - 1];
      return last === undefined ? undefined : (JSON.parse(last) as string);
    },
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

const voiceLine = (path: string, text: string) => `[Voice message, transcribed from ${path}: «${text}»]`;

describe("a voice message reaches the assistant as words", () => {
  let handle: RunBridgeHandle | undefined;

  afterEach(async () => {
    if (handle) await handle.shutdown();
    handle = undefined;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("asks for the transcript and opens the prompt with it, before the uploaded-file line", async () => {
    const run = await converse(
      "voice-transcript-ok",
      VOICE_MESSAGE,
      { transcripts: { status: 200, body: { text: TRANSCRIPT } } },
      (h) => (handle = h),
    );
    await ended(run, "succeeded");

    expect(run.transcripts).toHaveLength(1);
    expect(run.transcripts[0]!.url).toBe(`${CONTROL_PLANE}/api/internal/voice-transcripts`);
    expect(run.transcripts[0]!.body).toEqual({
      agent_id: "voice-transcript-ok",
      path: "uploads/1-0/voice.ogg",
    });

    const prompt = run.prompt();
    expect(prompt).toBeDefined();
    const line = voiceLine("uploads/1-0/voice.ogg", TRANSCRIPT);
    expect(prompt!.split("\n")).toContain(line);
    expect(prompt!.indexOf(line)).toBeLessThan(prompt!.indexOf(VOICE_MESSAGE));
    expect(prompt).toContain("lang=it");
  });

  it.each([502, 429])("leaves the turn exactly as it was when the transcript route answers %i", async (status) => {
    const run = await converse(
      `voice-transcript-${status}`,
      VOICE_MESSAGE,
      { transcripts: { status, body: { error: "not transcribed" } } },
      (h) => (handle = h),
    );
    await ended(run, "succeeded");

    expect(run.prompt()).toBe(
      `[turn_meta: gap=first, lang=unknown; before your first tool call, say in one line what you understood and will do]\n\n${VOICE_MESSAGE}`,
    );
    expect(run.prompt()).not.toContain("[Voice message");
    expect(run.transcripts).toHaveLength(1);
  });

  it("asks nothing when the credit gate says the tenant is exhausted", async () => {
    const run = await converse(
      "voice-transcript-no-credit",
      VOICE_MESSAGE,
      { creditStatus: 402, transcripts: { status: 200, body: { text: TRANSCRIPT } } },
      (h) => (handle = h),
    );
    await ended(run, "succeeded");

    expect(run.transcripts).toEqual([]);
    expect(run.prompt()).toBeUndefined();
  });

  it("asks nothing for a message whose upload is not audio", async () => {
    const run = await converse(
      "voice-transcript-pdf",
      "[Uploaded files: uploads/1-0/offerta.pdf]",
      { transcripts: { status: 200, body: { text: "not used" } } },
      (h) => (handle = h),
    );
    await ended(run, "succeeded");

    expect(run.transcripts).toEqual([]);
  });

  it("transcribes two audio files in one message, in order, and keeps that order in the prompt", async () => {
    const first = "uploads/1-0/voice.ogg";
    const second = "uploads/1-1/voice-two.mp3";
    const firstText = "Ciao Matilde, mi prepari la bozza dell'offerta?";
    const secondText = "Sì, preparala tu.";
    const transcripts = new Map([
      [first, firstText],
      [second, secondText],
    ]);

    const run = await converse(
      "voice-transcript-two",
      `[Uploaded files: ${first}, ${second}]`,
      { transcripts: (path) => ({ status: 200, body: { text: transcripts.get(path) ?? "" } }) },
      (h) => (handle = h),
    );
    await ended(run, "succeeded");

    expect(run.transcripts.map((call) => call.body.path)).toEqual([first, second]);

    const prompt = run.prompt();
    expect(prompt).toBeDefined();
    const firstLine = voiceLine(first, firstText);
    const secondLine = voiceLine(second, secondText);
    expect(prompt!.split("\n")).toContain(firstLine);
    expect(prompt!.split("\n")).toContain(secondLine);
    expect(prompt!.indexOf(firstLine)).toBeLessThan(prompt!.indexOf(secondLine));
    expect(prompt!.indexOf(secondLine)).toBeLessThan(prompt!.indexOf(`[Uploaded files: ${first}, ${second}]`));
  });
});

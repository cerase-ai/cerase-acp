import { describe, expect, it } from "vitest";
import { isTranscribableAudio, requestVoiceTranscript } from "./voice-transcript.js";

// A voice message is stored as an upload like any other file, but the
// assistant cannot hear it: the bridge asks the control-plane to transcribe it
// and puts the words in front of the turn. Unlike the file-link request this is
// best-effort -- a refused or slow transcription leaves the turn as it was --
// so the client answers null instead of throwing.

const CONTROL_PLANE = "http://control-plane.test:9999/";
const SECRET = "internal-secret";

const opts = (fetchImpl: typeof fetch, extra: { timeoutMs?: number } = {}) => ({
  controlPlaneUrl: CONTROL_PLANE,
  internalSecret: SECRET,
  fetchImpl,
  ...extra,
});

function recording(answer: unknown, status = 200) {
  const seen = { url: "", method: "", auth: "", contentType: "", body: "" };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.url = url;
    seen.method = init?.method ?? "";
    seen.auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
    seen.contentType = (init?.headers as Record<string, string> | undefined)?.["Content-Type"] ?? "";
    seen.body = (init?.body as string | undefined) ?? "";
    return new Response(JSON.stringify(answer), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

describe("requestVoiceTranscript", () => {
  it("POSTs the agent and the audio path to the internal transcript route", async () => {
    const { fetchImpl, seen } = recording({ text: "Ciao Matilde, mi prepari la bozza dell'offerta?" });

    await requestVoiceTranscript("agent-1", "uploads/1-0/voice.ogg", opts(fetchImpl));

    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("http://control-plane.test:9999/api/internal/voice-transcripts");
    expect(seen.auth).toBe(`Bearer ${SECRET}`);
    expect(seen.contentType).toBe("application/json");
    expect(JSON.parse(seen.body)).toEqual({
      agent_id: "agent-1",
      path: "uploads/1-0/voice.ogg",
    });
  });

  it("returns the text of a 200 answer", async () => {
    const { fetchImpl } = recording({ text: "Ciao Matilde, mi prepari la bozza dell'offerta?" });

    await expect(requestVoiceTranscript("agent-1", "uploads/1-0/voice.ogg", opts(fetchImpl))).resolves.toBe(
      "Ciao Matilde, mi prepari la bozza dell'offerta?",
    );
  });

  it.each([413, 422, 429, 502, 503])("returns null when the control-plane answers %i", async (status) => {
    const { fetchImpl } = recording({ error: "not transcribed" }, status);

    await expect(requestVoiceTranscript("agent-1", "uploads/1-0/voice.ogg", opts(fetchImpl))).resolves.toBeNull();
  });

  it("returns null when a 200 answer carries no text", async () => {
    const empty = recording({ text: "" });
    const missing = recording({});

    await expect(requestVoiceTranscript("agent-1", "uploads/1-0/voice.ogg", opts(empty.fetchImpl))).resolves.toBeNull();
    await expect(
      requestVoiceTranscript("agent-1", "uploads/1-0/voice.ogg", opts(missing.fetchImpl)),
    ).resolves.toBeNull();
  });

  it("returns null on a network error", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(requestVoiceTranscript("agent-1", "uploads/1-0/voice.ogg", opts(fetchImpl))).resolves.toBeNull();
  });

  it("returns null when the request outlives its timeout", async () => {
    // A request that hangs until somebody aborts it: without the timeout the
    // turn would wait for it forever.
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;

    await expect(
      requestVoiceTranscript("agent-1", "uploads/1-0/voice.ogg", opts(fetchImpl, { timeoutMs: 10 })),
    ).resolves.toBeNull();
  });
});

describe("isTranscribableAudio", () => {
  it.each(["ogg", "oga", "opus", "mp3", "m4a", "wav", "webm", "weba", "aac", "flac", "amr"])("accepts .%s", (ext) => {
    expect(isTranscribableAudio(`uploads/1-0/voice.${ext}`)).toBe(true);
  });

  it("accepts those extensions whatever their case", () => {
    expect(isTranscribableAudio("uploads/1-0/VOICE.OGG")).toBe(true);
    expect(isTranscribableAudio("uploads/1-0/Voice.Mp3")).toBe(true);
    expect(isTranscribableAudio("uploads/1-0/voice.WEBM")).toBe(true);
  });

  it("refuses anything that is not one of those audio files", () => {
    expect(isTranscribableAudio("uploads/1-0/offerta.pdf")).toBe(false);
    expect(isTranscribableAudio("uploads/1-0/notes.txt")).toBe(false);
    expect(isTranscribableAudio("uploads/1-0/voice.ogg.bak")).toBe(false);
    expect(isTranscribableAudio("uploads/1-0/voice")).toBe(false);
  });
});

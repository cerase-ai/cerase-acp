// Ask the control-plane to transcribe an uploaded voice message.
//
// The assistant never hears an audio upload: the bridge asks the control-plane
// to transcribe it and puts the words in front of the turn. Unlike the file-link
// request this is best-effort -- a refused, empty or slow transcription leaves
// the turn as it was -- so the client answers null instead of throwing.

import { makeLogger } from "./logger.js";

const logger = makeLogger("cerase-acp.voice-transcript");

/** The audio formats the control-plane's transcriber knows. */
const AUDIO_EXTENSIONS = new Set(["ogg", "oga", "opus", "mp3", "m4a", "wav", "webm", "weba", "aac", "flac", "amr"]);

export interface VoiceTranscriptOptions {
  controlPlaneUrl: string;
  internalSecret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * POST the agent and the workspace-relative audio path to the internal
 * transcript route and resolve with its words, or null when they cannot be
 * had: a non-2xx, an answer with no text, a network error, or the timeout.
 */
export async function requestVoiceTranscript(
  agentId: string,
  path: string,
  opts: VoiceTranscriptOptions,
): Promise<string | null> {
  const f = opts.fetchImpl ?? fetch;
  const url = `${opts.controlPlaneUrl.replace(/\/$/, "")}/api/internal/voice-transcripts`;
  try {
    const resp = await f(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.internalSecret}`,
      },
      body: JSON.stringify({ agent_id: agentId, path }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
    });
    if (!resp.ok) {
      logger.warn({ agentId, path, status: resp.status }, "the voice transcript request was refused");
      return null;
    }
    const answer = (await resp.json()) as { text?: unknown };
    if (typeof answer.text !== "string" || answer.text.trim() === "") {
      logger.warn({ agentId, path, status: resp.status }, "the voice transcript answer carried no text");
      return null;
    }
    return answer.text;
  } catch (err) {
    logger.warn({ err, agentId, path }, "the voice transcript request failed");
    return null;
  }
}

/** Whether a stored upload is one of the audio formats worth transcribing. */
export function isTranscribableAudio(path: string): boolean {
  const ext = /\.([^./]+)$/.exec(path)?.[1];
  return ext !== undefined && AUDIO_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * The line the prompt opens with for a transcribed upload. Newlines are
 * collapsed so the marker stays one line, and the two characters that could
 * end it early are replaced: a transcript is the person's words, not the
 * bridge's syntax.
 */
export function voiceTranscriptLine(path: string, text: string): string {
  const spoken = text.replace(/\r?\n/g, " ").replace(/»/g, '"').replace(/\]/g, ")");
  return `[Voice message, transcribed from ${path}: «${spoken}»]`;
}

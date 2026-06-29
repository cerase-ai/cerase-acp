// C4 — inbound chat attachments: download files a user sent (Discord/Telegram/
// Slack/Workspace Chat/panel), drop them into the agent's workspace, and prepend
// the `[Uploaded files: <paths>]` marker the `message-attachment-receiver` skill
// consumes (it routes each path to the OCR / transcribe / docreader recipes).
//
// This is the bridge-side half that was missing: the agent-side skill + recipes
// already exist, but no adapter downloaded inbound files or emitted the marker —
// so attachments never reached the agent. The logic lives here (pure +
// injectable) so it is unit-tested without channel SDKs / real docker / network.

import { makeLogger } from "./logger.js";
import { type FileWriter, writeAgentWorkspaceFile } from "./workspace-files.js";

const logger = makeLogger("cerase-acp.attachments");

/**
 * M-FILE-LIMITS-1 — inbound chat-upload cap, in MB. Operator-tunable via
 * CERASE_MAX_ATTACHMENT_MB (default 64). This is the operator's global setting;
 * the EFFECTIVE per-channel cap is `min(this, the channel's platform ceiling)` —
 * see `effectiveMaxMb`. Whichever is lower binds.
 */
export const MAX_ATTACHMENT_MB = Number(process.env.CERASE_MAX_ATTACHMENT_MB) || 64;
const DEFAULT_MAX_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024;

/** The chat channels that ingest inbound attachments (the web panel doesn't). */
export type Channel = "discord" | "telegram" | "slack" | "workspace-chat";

/**
 * Each channel's real platform ceiling for an inbound file, in MB. The
 * EFFECTIVE cap is `min(MAX_ATTACHMENT_MB, this)`. Discord caps DM uploads at
 * ~25 MB; Telegram's Bot API getFile download tops out at 20 MB (the LOWEST of
 * the lot — lower than Discord); Slack allows up to ~1 GB. A channel with NO
 * entry here falls back to the global setting alone — workspace-chat is the
 * internal web chat, which has no platform ceiling, so it is intentionally
 * omitted and the operator's MAX_ATTACHMENT_MB binds.
 */
const CHANNEL_MAX_MB: Partial<Record<Channel, number>> = { discord: 25, telegram: 20, slack: 1024 };

/** The effective inbound cap for a channel, in MB: min(global setting, channel ceiling). */
export function effectiveMaxMb(channel: Channel): number {
  return Math.min(MAX_ATTACHMENT_MB, CHANNEL_MAX_MB[channel] ?? Number.POSITIVE_INFINITY);
}

export interface InboundFile {
  /** Original filename as the channel reports it. */
  name: string;
  /** A URL the bridge can GET to fetch the bytes. */
  url: string;
}

/** Injectable for tests: GET a URL → bytes. Defaults to global fetch. */
export type UrlFetcher = (url: string, headers?: Record<string, string>) => Promise<Buffer>;

/**
 * M-FILE-LIMITS-1 (fail-loud) — a file the ingest refused because it exceeded
 * the size cap. Surfaced to the caller so the adapter can TELL the user the
 * upload was dropped, instead of the old silent skip.
 */
export interface RejectedFile {
  /** Original filename as the channel reported it. */
  name: string;
  /** The fetched size that blew the cap, in bytes. */
  sizeBytes: number;
  /** Why it was refused. Only `oversize` today; an enum for future reasons. */
  reason: "oversize";
}

/**
 * The outcome of an ingest: the workspace paths that were stored, plus any
 * files refused by the cap. `rejected` is non-empty → the adapter must notify
 * the user (M-FILE-LIMITS-1 fail-loud); the stored files still flow normally.
 */
export interface IngestResult {
  stored: string[];
  rejected: RejectedFile[];
}

export interface IngestOptions {
  maxBytes?: number;
  /** GET a URL → bytes. */
  fetcher?: UrlFetcher;
  /** Write bytes into the container workspace (passed through to the writer). */
  writer?: FileWriter;
  /** Monotonic-ish folder stamp; injected in tests. Defaults to Date.now(). */
  now?: () => number;
  /** Extra request headers for the fetch (e.g. Slack's `Authorization: Bearer …`). */
  headers?: Record<string, string>;
}

const realFetcher: UrlFetcher = async (url, headers) => {
  const res = await fetch(url, headers ? { headers } : undefined);
  if (!res.ok) {
    throw new Error(`attachment fetch failed: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
};

/**
 * Sanitise a channel-supplied filename to its safe basename: strip any
 * directory part, keep only `[A-Za-z0-9._-]`, collapse the rest to `_`. Never
 * empty (falls back to `file`).
 */
export function sanitizeFilename(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1).slice(name.lastIndexOf("\\") + 1);
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned === "" ? "file" : cleaned.slice(0, 128);
}

/**
 * Shared core: write each named buffer into the agent workspace under
 * `uploads/<ts>-<i>/<sanitized-name>`, returning the stored workspace-relative
 * paths plus the files refused by the size cap. A file that fails to
 * fetch/write is logged and skipped — one bad attachment never drops the whole
 * turn — but an over-cap file is recorded in `rejected` so the adapter can
 * fail loud (M-FILE-LIMITS-1) instead of dropping it silently.
 */
async function storeInbound(
  containerName: string,
  items: Array<{ name: string; get: () => Promise<Buffer> }>,
  channel: Channel,
  opts?: IngestOptions,
): Promise<IngestResult> {
  // The effective cap is the lower of the operator's setting (or an explicit
  // per-call override) and this channel's platform ceiling.
  const channelBytes = effectiveMaxMb(channel) * 1024 * 1024;
  const maxBytes = Math.min(opts?.maxBytes ?? DEFAULT_MAX_BYTES, channelBytes);
  const now = opts?.now ?? (() => Date.now());
  const stamp = now();

  const stored: string[] = [];
  const rejected: RejectedFile[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const relPath = `uploads/${stamp}-${i}/${sanitizeFilename(item.name)}`;
    try {
      const bytes = await item.get();
      if (bytes.length > maxBytes) {
        logger.warn({ containerName, name: item.name, size: bytes.length }, "inbound attachment over cap — rejected");
        rejected.push({ name: item.name, sizeBytes: bytes.length, reason: "oversize" });
        continue;
      }
      await writeAgentWorkspaceFile(containerName, relPath, bytes, { maxBytes, writer: opts?.writer });
      stored.push(relPath);
    } catch (err) {
      logger.warn({ err, containerName, name: item.name }, "inbound attachment fetch/write failed — skipped");
    }
  }
  return { stored, rejected };
}

/**
 * Download each URL-addressable inbound file (Discord/Telegram/Slack) and store
 * it in the agent workspace. `opts.headers` is sent on every fetch (Slack's
 * `url_private` needs the bot token).
 */
export async function ingestInboundAttachments(
  containerName: string,
  files: InboundFile[],
  channel: Channel,
  opts?: IngestOptions,
): Promise<IngestResult> {
  const fetcher = opts?.fetcher ?? realFetcher;
  return storeInbound(
    containerName,
    files.map((f) => ({ name: f.name, get: () => fetcher(f.url, opts?.headers) })),
    channel,
    opts,
  );
}

/**
 * Store already-fetched buffers (Workspace Chat, whose attachments come via the
 * Google Chat media-download API, not a plain URL). Same workspace layout +
 * skip-on-failure as the URL path.
 */
export async function ingestInboundBuffers(
  containerName: string,
  files: Array<{ name: string; bytes: Buffer }>,
  channel: Channel,
  opts?: IngestOptions,
): Promise<IngestResult> {
  return storeInbound(
    containerName,
    files.map((f) => ({ name: f.name, get: async () => f.bytes })),
    channel,
    opts,
  );
}

/**
 * Prepend the `[Uploaded files: …]` marker the skill consumes. No stored paths
 * → the text is returned unchanged. Empty body (attachment-only message) → the
 * marker stands alone.
 */
export function prependUploadMarker(text: string, relPaths: string[]): string {
  if (relPaths.length === 0) {
    return text;
  }
  const marker = `[Uploaded files: ${relPaths.join(", ")}]`;
  const body = text.trim();
  return body === "" ? marker : `${marker}\n\n${body}`;
}

/**
 * M-FILE-LIMITS-1 (fail-loud) — build the Italian, user-facing notice telling
 * the user which uploads were dropped for exceeding the size cap. Returns
 * `undefined` when nothing was rejected (so the caller sends nothing). Every
 * real adapter calls this after ingest and, if a string comes back, delivers
 * it via `dispatcher.sendSystemMessage` — replacing the old silent drop.
 */
export function buildOversizeNotice(rejected: RejectedFile[], channel: Channel): string | undefined {
  const oversize = rejected.filter((r) => r.reason === "oversize");
  if (oversize.length === 0) {
    return undefined;
  }
  // Report the EFFECTIVE per-channel cap, so the user sees the real ceiling
  // that bound (e.g. 25 MB on Discord), not just the global setting.
  const cap = effectiveMaxMb(channel);
  if (oversize.length === 1) {
    return `Il file «${oversize[0]!.name}» supera il limite di ${cap} MB e non è stato caricato.`;
  }
  const names = oversize.map((r) => `«${r.name}»`).join(", ");
  return `I file ${names} superano il limite di ${cap} MB e non sono stati caricati.`;
}

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

/** Discord free-tier ceiling — the largest common denominator. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export interface InboundFile {
  /** Original filename as the channel reports it. */
  name: string;
  /** A URL the bridge can GET to fetch the bytes. */
  url: string;
}

/** Injectable for tests: GET a URL → bytes. Defaults to global fetch. */
export type UrlFetcher = (url: string, headers?: Record<string, string>) => Promise<Buffer>;

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
 * paths. A file that fails to fetch/write is logged and skipped — one bad
 * attachment never drops the whole turn.
 */
async function storeInbound(
  containerName: string,
  items: Array<{ name: string; get: () => Promise<Buffer> }>,
  opts?: IngestOptions,
): Promise<string[]> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = opts?.now ?? (() => Date.now());
  const stamp = now();

  const stored: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const relPath = `uploads/${stamp}-${i}/${sanitizeFilename(item.name)}`;
    try {
      const bytes = await item.get();
      if (bytes.length > maxBytes) {
        logger.warn({ containerName, name: item.name, size: bytes.length }, "inbound attachment over cap — skipped");
        continue;
      }
      await writeAgentWorkspaceFile(containerName, relPath, bytes, { maxBytes, writer: opts?.writer });
      stored.push(relPath);
    } catch (err) {
      logger.warn({ err, containerName, name: item.name }, "inbound attachment fetch/write failed — skipped");
    }
  }
  return stored;
}

/**
 * Download each URL-addressable inbound file (Discord/Telegram/Slack) and store
 * it in the agent workspace. `opts.headers` is sent on every fetch (Slack's
 * `url_private` needs the bot token).
 */
export async function ingestInboundAttachments(
  containerName: string,
  files: InboundFile[],
  opts?: IngestOptions,
): Promise<string[]> {
  const fetcher = opts?.fetcher ?? realFetcher;
  return storeInbound(
    containerName,
    files.map((f) => ({ name: f.name, get: () => fetcher(f.url, opts?.headers) })),
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
  opts?: IngestOptions,
): Promise<string[]> {
  return storeInbound(
    containerName,
    files.map((f) => ({ name: f.name, get: async () => f.bytes })),
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

// C4 — inbound chat attachments: download files a user sent (Discord/Telegram/
// panel), drop them into the agent's workspace, and prepend the
// `[Uploaded files: <paths>]` marker the `message-attachment-receiver` skill
// consumes (it routes each path to the OCR / transcribe / docreader recipes).
//
// This is the bridge-side half that was missing: the agent-side skill +
// recipes already exist, but no adapter downloaded inbound files or emitted the
// marker — so attachments never reached the agent. The logic lives here (pure +
// injectable) so it is unit-tested without discord.js / real docker / network.

import { writeAgentWorkspaceFile, type FileWriter } from "./workspace-files.js";
import { makeLogger } from "./logger.js";

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
export type UrlFetcher = (url: string) => Promise<Buffer>;

export interface IngestOptions {
  maxBytes?: number;
  /** GET a URL → bytes. */
  fetcher?: UrlFetcher;
  /** Write bytes into the container workspace (passed through to the writer). */
  writer?: FileWriter;
  /** Monotonic-ish folder stamp; injected in tests. Defaults to Date.now(). */
  now?: () => number;
}

const realFetcher: UrlFetcher = async (url) => {
  const res = await fetch(url);
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
 * Download each inbound file and write it into the agent's workspace under
 * `uploads/<ts>/<sanitized-name>`. Returns the workspace-relative paths that
 * were stored (in order). A file that fails to fetch/write is logged and
 * skipped — one bad attachment never drops the whole turn.
 */
export async function ingestInboundAttachments(
  containerName: string,
  files: InboundFile[],
  opts?: IngestOptions,
): Promise<string[]> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const fetcher = opts?.fetcher ?? realFetcher;
  const now = opts?.now ?? (() => Date.now());
  const stamp = now();

  const stored: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    // Distinct subfolder per file index keeps same-named files from clobbering.
    const relPath = `uploads/${stamp}-${i}/${sanitizeFilename(file.name)}`;
    try {
      const bytes = await fetcher(file.url);
      if (bytes.length > maxBytes) {
        logger.warn({ containerName, name: file.name, size: bytes.length }, "inbound attachment over cap — skipped");
        continue;
      }
      await writeAgentWorkspaceFile(containerName, relPath, bytes, { maxBytes, writer: opts?.writer });
      stored.push(relPath);
    } catch (err) {
      logger.warn({ err, containerName, name: file.name }, "inbound attachment fetch/write failed — skipped");
    }
  }
  return stored;
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

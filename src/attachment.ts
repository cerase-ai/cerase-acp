// CHAT-UX / ATTACH-1 — outgoing chat attachments via a `[[attach: <path>]]`
// marker in the agent's reply.
//
// Same shape as approval-link.ts: the agent emits a marker in its
// outgoing text; the bridge intercepts it, uploads the referenced
// workspace file as a channel attachment, and never shows the raw
// marker to the user. Paths are workspace-relative and traversal-guarded
// (the agent supplies them, so a `/etc/...` or `../` must never read
// outside its own ~/cerase/workspace).

const MARKER = /\[\[\s*attach\s*:\s*([^\]]+?)\s*\]\]/gi;

/** True when `p` is a safe, workspace-relative path (no abs, no `..`). */
export function isSafeWorkspacePath(p: string): boolean {
  if (!p || p.startsWith("/")) return false;
  // Reject any `..` segment (POSIX-style; the workspace is a Linux container).
  return !p.split("/").some((seg) => seg === "..");
}

export interface ParsedAttachments {
  /** The reply text with every `[[attach: …]]` marker removed. */
  text: string;
  /** The validated, workspace-relative file paths to upload, in order. */
  attachments: string[];
}

/**
 * Pull `[[attach: <path>]]` markers out of an outgoing message. Unsafe
 * paths (absolute / traversal) are stripped from the text but NOT
 * attached. Whitespace left by the removed markers is collapsed so the
 * visible reply reads cleanly.
 */
export function parseAttachments(text: string): ParsedAttachments {
  const attachments: string[] = [];
  const stripped = text.replace(MARKER, (_m, rawPath: string) => {
    const path = rawPath.trim();
    if (isSafeWorkspacePath(path)) attachments.push(path);
    return " ";
  });
  // Collapse the whitespace the markers left behind, then trim.
  const cleaned = stripped
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +\n/g, "\n")
    .trim();
  return { text: cleaned, attachments };
}

/** True when a message carries at least one attach marker. */
export function hasAttachments(text: string): boolean {
  MARKER.lastIndex = 0;
  return MARKER.test(text);
}

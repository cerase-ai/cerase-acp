// Outgoing chat attachments via a `[[attach: <path>]]` marker in the agent's
// reply.
//
// Same shape as approval-link.ts: the agent emits a marker in its
// outgoing text; the bridge intercepts it, uploads the referenced
// workspace file as a channel attachment, and never shows the raw
// marker to the user. Paths are workspace-relative and traversal-guarded
// (the agent supplies them, so a `/etc/...` or `../` must never read
// outside its own ~/cerase/workspace).
//
// A marker is recognised only whole, so every place that cuts a reply into
// pieces asks `markerSpans` where it must not cut: the stream buffer, and the
// split of an answer into the messages a channel takes.

const MARKER = /\[\[\s*attach\s*:\s*([^\]]+?)\s*\]\]/gi;

// What is left of a marker once the whole ones are out: one closed on nothing,
// an opening that never closed, up to its first bracket or the end of its line,
// and the tail of one cut before it, at the very start of the text.
const OPEN_MARKER = /\[\[\s*attach\s*:([^\]\n]*)\]{0,2}/gi;
const MARKER_TAIL = /^\s*[^\s[\]]*\]\]/;

/**
 * The most characters a marker runs, brackets included. A `[[` that has not
 * closed within it, or before its line ends, is text rather than a marker
 * still being written.
 */
export const MARKER_MAX_CHARS = 512;

/** True when `p` is a safe, workspace-relative path (no abs, no `..`). */
export function isSafeWorkspacePath(p: string): boolean {
  if (!p || p.startsWith("/")) return false;
  // Reject any `..` segment (POSIX-style; the workspace is a Linux container).
  return !p.split("/").some((seg) => seg === "..");
}

/** A marker that named no file the bridge may send. */
export interface RefusedMarker {
  /** The file as the reader would name it, or "" when the marker names none. */
  name: string;
  /** Why nothing was attached, in the words the assistant is told. */
  reason: string;
}

export interface ParsedAttachments {
  /** The reply text with every `[[attach: …]]` marker removed. */
  text: string;
  /** The validated, workspace-relative file paths to upload, in order. */
  attachments: string[];
  /** The markers removed with nothing to upload, each of which promised the person a file. */
  refused: RefusedMarker[];
}

/** The last segment of a path the model wrote, without the dots a cut leaves at its end. */
function nameOf(rawPath: string): string {
  const segments = rawPath
    .trim()
    .replace(/[.\s]+$/, "")
    .split("/")
    .filter((s) => s !== "" && s !== "..");
  return segments[segments.length - 1] ?? "";
}

/**
 * Pull `[[attach: <path>]]` markers out of an outgoing message. A marker whose
 * path is absolute, climbs out of the workspace or is empty, and what is left
 * of one that was never closed, are taken out of the text too and reported in
 * `refused` rather than attached. The tail of a marker cut before it, at the
 * start of the text, is removed without a report: its head was reported where
 * the cut left it. Whitespace left by the removed markers is collapsed so the
 * visible reply reads cleanly; a text with nothing to remove comes back as it
 * was, so the result differs from the input exactly when a marker was found.
 */
export function parseAttachments(text: string): ParsedAttachments {
  const attachments: string[] = [];
  const refused: RefusedMarker[] = [];
  let removed = false;
  const stripped = text
    .replace(MARKER, (_m, rawPath: string) => {
      removed = true;
      const path = rawPath.trim();
      if (isSafeWorkspacePath(path)) attachments.push(path);
      else
        refused.push({
          name: nameOf(path),
          reason: path
            ? "the marker named a path outside the workspace, which the bridge never reads; a file is named by its path inside the workspace"
            : "the marker names no file",
        });
      return " ";
    })
    .replace(OPEN_MARKER, (m: string, rawPath: string) => {
      removed = true;
      refused.push({
        name: nameOf(rawPath),
        reason: m.endsWith("]]")
          ? "the marker names no file"
          : "the marker was not closed with ]], so the file it named could not be read from it",
      });
      return " ";
    })
    .replace(MARKER_TAIL, () => {
      removed = true;
      return " ";
    });
  if (!removed) return { text, attachments, refused };
  // Collapse the whitespace the markers left behind, then trim.
  const cleaned = stripped
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +\n/g, "\n")
    .trim();
  return { text: cleaned, attachments, refused };
}

/** Where a marker lies in a text: from its `[[` to just past its `]]`, or to the end of the text while it is open. */
export interface MarkerSpan {
  start: number;
  end: number;
  open: boolean;
}

/**
 * The places in `text` no cut may fall inside: every `[[` with the `]]` that
 * closes it on the same line, and a `[[` near the end of the text that has not
 * closed yet, which runs to the end. Anything longer than MARKER_MAX_CHARS, or
 * broken by a line end, is text.
 */
export function markerSpans(text: string): MarkerSpan[] {
  const spans: MarkerSpan[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf("[[", from);
    if (start < 0) return spans;
    const close = text.indexOf("]]", start + 2);
    const lineEnd = text.indexOf("\n", start + 2);
    if (close >= 0 && (lineEnd < 0 || close < lineEnd)) {
      if (close + 2 - start <= MARKER_MAX_CHARS) spans.push({ start, end: close + 2, open: false });
      from = close + 2;
      continue;
    }
    if (lineEnd < 0 && text.length - start <= MARKER_MAX_CHARS) spans.push({ start, end: text.length, open: true });
    from = start + 2;
  }
}

/** Where a marker still being written starts, at the end of `text`, or -1 when none is. */
export function openMarkerStart(text: string): number {
  const last = markerSpans(text).at(-1);
  return last?.open ? last.start : -1;
}

/**
 * A place to cut `text` at that leaves every marker whole: `at` itself, or the
 * start of the marker it would fall inside. A marker that starts the text has
 * no place before it, and is cut at `at` as anything that long would be.
 */
export function cutOutsideMarkers(text: string, at: number): number {
  const inside = markerSpans(text).find((s) => s.start < at && at < s.end);
  return inside && inside.start > 0 ? inside.start : at;
}

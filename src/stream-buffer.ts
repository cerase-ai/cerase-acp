// Accumulates `agent_message_chunk` text from the ACP stream and
// flushes it as discrete pieces to a downstream send queue. Without
// buffering we'd emit one Discord message per token; without flushing
// at sentence boundaries we'd produce one wall-of-text reply only when
// the turn ends.
//
// Flush triggers (any one of):
//   1. `text` contains a sentence terminator (., !, ?, newline) AND
//      buffer size >= sentenceMinChars
//   2. buffer size >= maxChars (hard cap — leaves margin for the send
//      queue to chunk before Discord's 2000-char limit)
//   3. `idleMs` elapsed since the last push and buffer is non-empty
//
// None of the three cuts inside an attach marker, `[[attach: <path>]]`: the
// path has a dot before its extension, and a marker cut in two is recognised in
// neither half. A cut falls before a marker instead, and one still being
// written waits for the rest of it (attachment.ts says how long a `[[` may stay
// open before it counts as text).
//
// A caller can also ask the buffer to stop flushing for a while (see
// `holdFrom`): some text can only be judged whole, and once a piece of it
// has been sent there is nothing left to judge.
//
// With `wholeMessages` none of the three triggers applies: the buffer sends
// only when `flush()` or `end()` asks it to, so a channel that takes an answer
// as one message is handed the answer in one piece.

export interface StreamBufferOptions {
  onFlush: (text: string) => void;
  /** Min chars before a sentence boundary triggers a flush. Default 200. */
  sentenceMinChars?: number;
  /** Hard cap; flush when reached even if no boundary. Default 1800. */
  maxChars?: number;
  /** Idle timer (ms) after the last push. Default 500. */
  idleMs?: number;
  /**
   * Asked about every piece just before it would be flushed. An index answers
   * that a HOLD starts there: the part of the piece before it is flushed as
   * usual, and from it on nothing is, including anything pushed later. The
   * held text stays in the buffer exactly as it was pushed — nothing trimmed
   * between pieces, so line starts survive — until `release()` or `end()`
   * hands it to `onHeld` in one string. -1 means no hold.
   */
  holdFrom?: (piece: string) => number;
  /** Receives held text. Defaults to `onFlush`. */
  onHeld?: (text: string) => void;
  /**
   * When true, no sentence boundary, cap or idle timer flushes the buffer:
   * text goes out only when `flush()` or `end()` is called, judged for a hold
   * as every flush is. Default false.
   */
  wholeMessages?: boolean;
}

import { markerSpans, openMarkerStart } from "./attachment.js";

const SENTENCE_END = /[.!?\n]/;

// The start of a marker naming a file, matched loosely because the marker may
// still be arriving: the buffer only has to know that the words it just held
// are introducing a file, not yet where that file lives.
const ATTACH_START = /\[\[\s*attach\s*:/i;

/**
 * How long a held-back piece waits for the next words of the reply before it
 * goes out on its own. A sentence that ends just before a file's `[[attach: …]]`
 * marker is the sentence that introduces the file, and the marker arrives in a
 * later push: this is the window in which it may follow, so the two can leave as
 * one piece. It is long enough to cover the gap between one reply's last words
 * and its marker, and short enough that a model which stopped mid-reply never
 * keeps a finished sentence from the person.
 */
export const MARKER_HOLD_MS = 1500;

export class StreamBuffer {
  private buffer = "";
  private idleTimer?: NodeJS.Timeout;
  private readonly sentenceMinChars: number;
  private readonly maxChars: number;
  private readonly idleMs: number;
  private readonly onFlush: (text: string) => void;
  private readonly holdFrom?: (piece: string) => number;
  private readonly onHeld: (text: string) => void;
  private readonly wholeMessages: boolean;
  private ended = false;
  private holding = false;
  // The cut of a piece held back for the next non-whitespace text, -1 when none.
  // The buffer is left whole; the piece leaves when the next words are read, or
  // when the hold ceiling passes.
  private deferredCut = -1;
  private deferredTimer?: NodeJS.Timeout;
  // No boundary cut may fall before this index: set once a held sentence is
  // known to introduce an attach marker, so it cannot be split from it again.
  private cutFloor = 0;

  constructor(opts: StreamBufferOptions) {
    this.onFlush = opts.onFlush;
    this.sentenceMinChars = opts.sentenceMinChars ?? 200;
    this.maxChars = opts.maxChars ?? 1800;
    this.idleMs = opts.idleMs ?? 500;
    this.holdFrom = opts.holdFrom;
    this.onHeld = opts.onHeld ?? opts.onFlush;
    this.wholeMessages = opts.wholeMessages ?? false;
  }

  push(text: string): void {
    if (this.ended || !text) return;

    // A held-back piece waits for the next words, which say whether it is the
    // sentence a file marker introduces.
    if (this.deferredCut >= 0) {
      if (text.trim().length === 0) {
        // Only whitespace: nothing to decide, and it cannot open a marker.
        this.buffer += text;
        return;
      }
      this.buffer += text;
      this.settleDeferred();
    } else {
      this.buffer += text;
    }

    // Held text waits for release() or end(); no boundary, cap or timer
    // applies to it, nor to any text of a buffer that keeps messages whole.
    if (this.holding || this.wholeMessages) return;
    this.resetIdleTimer();

    // Boundary flush, when a sentence ends outside every marker.
    if (this.buffer.length >= this.sentenceMinChars && SENTENCE_END.test(this.buffer)) {
      if (this.holdAtBoundary()) return;
    }
    // Hard-cap flush: when the buffer crosses the threshold, ship the
    // whole thing in one piece and let the downstream send-queue chunk
    // it further if needed. We don't want to slice on arbitrary char
    // boundaries here. A marker still being written stays behind.
    if (this.buffer.length >= this.maxChars) {
      if (this.startsHold(this.buffer)) return;
      const open = openMarkerStart(this.buffer);
      if (open < 0) {
        this.emit(this.buffer);
        this.buffer = "";
        this.cutFloor = 0;
      } else if (open > 0) {
        this.emit(this.buffer.slice(0, open).trimEnd());
        this.buffer = this.buffer.slice(open);
        this.cutFloor = 0;
      }
    }
  }

  /**
   * Send what the buffer holds now, as the idle timer would: the part before a
   * hold that starts in it goes to `onFlush`, and the hold starts. A no-op while
   * a hold is on, since held text waits for `release()` or `end()`.
   */
  flush(): void {
    if (this.ended || this.holding || this.buffer.length === 0) return;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    // An explicit flush sends what is held together with the rest.
    this.cancelDeferredTimer();
    this.deferredCut = -1;
    this.cutFloor = 0;
    if (this.startsHold(this.buffer)) return;
    this.emit(this.buffer.trimEnd());
    this.buffer = "";
  }

  /**
   * End a hold: everything held goes to `onHeld` in one string and the buffer
   * goes back to flushing as usual. A no-op when nothing is held.
   */
  release(): void {
    if (!this.holding) return;
    const held = this.buffer.trim();
    this.buffer = "";
    this.cutFloor = 0;
    this.holding = false;
    if (held.length > 0) this.onHeld(held);
  }

  /**
   * End without sending: whatever is buffered or held is dropped, and nothing
   * pushed later is taken. For a reply that will be written again from the
   * start, where flushing the rest of the first one would send half of it.
   */
  discard(): void {
    this.ended = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.cancelDeferredTimer();
    this.deferredCut = -1;
    this.buffer = "";
    this.cutFloor = 0;
    this.holding = false;
  }

  end(): void {
    this.ended = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    // end() sends what is held together with the rest.
    this.cancelDeferredTimer();
    this.deferredCut = -1;
    if (this.holding) {
      this.release();
      return;
    }
    if (this.buffer.length > 0) {
      if (this.startsHold(this.buffer)) {
        this.release();
        return;
      }
      this.emit(this.buffer.trimEnd());
      this.buffer = "";
      this.cutFloor = 0;
    }
  }

  /**
   * The sentence-boundary flush, held back for the next words. The piece it
   * would send is the head of the buffer up to the last sentence end; a sentence
   * that ends just before a file's `[[attach: …]]` marker must leave together
   * with that marker, and the marker arrives in a later push. A piece whose
   * marker is already after it is kept with no wait. False when there is no
   * boundary to cut at, so the caller can try the size cap instead.
   */
  private holdAtBoundary(): boolean {
    // Find the LAST sentence terminator so we ship as much complete
    // text as possible without breaking a mid-sentence.
    const spans = markerSpans(this.buffer);
    let cut = -1;
    for (let i = this.buffer.length - 1; i >= this.cutFloor; i--) {
      const c = this.buffer[i]!;
      if (c !== "." && c !== "!" && c !== "?" && c !== "\n") continue;
      if (spans.some((s) => s.start <= i && i < s.end)) continue;
      cut = i;
      break;
    }
    if (cut < 0) return false;
    if (this.startsHold(this.buffer.slice(0, cut + 1))) return true;
    // The marker is already here: keep the sentence with it, and let no cut
    // split the two again.
    if (ATTACH_START.test(this.buffer.slice(cut + 1))) {
      this.cutFloor = cut + 1;
      return true;
    }
    this.defer(cut);
    return true;
  }

  /**
   * The next non-whitespace words after a held-back piece have arrived. When the
   * buffer from the cut on opens the marker of the file the sentence introduces,
   * the sentence stays with it and leaves in the same piece; otherwise the
   * sentence goes out now, as it always did.
   */
  private settleDeferred(): void {
    this.cancelDeferredTimer();
    const cut = this.deferredCut;
    this.deferredCut = -1;
    if (cut < 0) return;
    if (ATTACH_START.test(this.buffer.slice(cut + 1))) {
      this.cutFloor = cut + 1;
      return;
    }
    const segment = this.buffer.slice(0, cut + 1).trimEnd();
    this.buffer = this.buffer.slice(cut + 1).trimStart();
    this.cutFloor = 0;
    this.emit(segment);
  }

  /** Hold the piece ending at `cut` for the next words, up to the ceiling. */
  private defer(cut: number): void {
    this.deferredCut = cut;
    if (this.deferredTimer) clearTimeout(this.deferredTimer);
    this.deferredTimer = setTimeout(() => {
      this.deferredTimer = undefined;
      const held = this.deferredCut;
      this.deferredCut = -1;
      if (held < 0 || this.ended) return;
      // The model paused: the finished piece must not wait any longer.
      const segment = this.buffer.slice(0, held + 1).trimEnd();
      this.buffer = this.buffer.slice(held + 1).trimStart();
      this.cutFloor = 0;
      this.emit(segment);
      if (this.buffer.length > 0 && !this.holding && !this.wholeMessages) this.resetIdleTimer();
    }, MARKER_HOLD_MS);
  }

  private cancelDeferredTimer(): void {
    if (this.deferredTimer) {
      clearTimeout(this.deferredTimer);
      this.deferredTimer = undefined;
    }
  }

  /**
   * What the idle timer sends: everything, as `flush()` does, except a marker
   * still being written at the end, which waits for the next push or for
   * `end()`. The text before it is held for the next words rather than sent
   * without them, since they may be the marker of the file it introduces.
   */
  private flushIdle(): void {
    if (this.ended || this.holding || this.buffer.length === 0) return;
    if (this.deferredCut >= 0) return;
    const open = openMarkerStart(this.buffer);
    if (open < 0) {
      this.flush();
      return;
    }
    if (open === 0) return;
    if (this.startsHold(this.buffer.slice(0, open))) return;
    this.defer(open - 1);
  }

  /**
   * Ask the caller whether a hold starts inside `piece`, and start it if so.
   * The piece is always the head of the buffer, so the index it answers is an
   * index into the buffer too: what comes before it is flushed, and the buffer
   * keeps the rest untouched.
   */
  private startsHold(piece: string): boolean {
    const at = this.holdFrom ? this.holdFrom(piece) : -1;
    if (at < 0) return false;
    const before = this.buffer.slice(0, at).trimEnd();
    this.buffer = this.buffer.slice(at);
    this.holding = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (before.length > 0) this.emit(before);
    return true;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.flushIdle();
    }, this.idleMs);
  }

  private emit(text: string): void {
    if (text.length > 0) this.onFlush(text);
  }
}

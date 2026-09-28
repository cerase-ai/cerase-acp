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
// A caller can also ask the buffer to stop flushing for a while (see
// `holdFrom`): some text can only be judged whole, and once a piece of it
// has been sent there is nothing left to judge.

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
}

const SENTENCE_END = /[.!?\n]/;

export class StreamBuffer {
  private buffer = "";
  private idleTimer?: NodeJS.Timeout;
  private readonly sentenceMinChars: number;
  private readonly maxChars: number;
  private readonly idleMs: number;
  private readonly onFlush: (text: string) => void;
  private readonly holdFrom?: (piece: string) => number;
  private readonly onHeld: (text: string) => void;
  private ended = false;
  private holding = false;

  constructor(opts: StreamBufferOptions) {
    this.onFlush = opts.onFlush;
    this.sentenceMinChars = opts.sentenceMinChars ?? 200;
    this.maxChars = opts.maxChars ?? 1800;
    this.idleMs = opts.idleMs ?? 500;
    this.holdFrom = opts.holdFrom;
    this.onHeld = opts.onHeld ?? opts.onFlush;
  }

  push(text: string): void {
    if (this.ended || !text) return;
    this.buffer += text;
    // Held text waits for release() or end(); no boundary, cap or timer
    // applies to it.
    if (this.holding) return;
    this.resetIdleTimer();

    // Boundary flush
    if (this.buffer.length >= this.sentenceMinChars && SENTENCE_END.test(this.buffer)) {
      this.flushAtLastBoundary();
      return;
    }
    // Hard-cap flush: when the buffer crosses the threshold, ship the
    // whole thing in one piece and let the downstream send-queue chunk
    // it further if needed. We don't want to slice on arbitrary char
    // boundaries here.
    if (this.buffer.length >= this.maxChars) {
      if (this.startsHold(this.buffer)) return;
      this.emit(this.buffer);
      this.buffer = "";
    }
  }

  /**
   * End a hold: everything held goes to `onHeld` in one string and the buffer
   * goes back to flushing as usual. A no-op when nothing is held.
   */
  release(): void {
    if (!this.holding) return;
    const held = this.buffer.trim();
    this.buffer = "";
    this.holding = false;
    if (held.length > 0) this.onHeld(held);
  }

  end(): void {
    this.ended = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
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
    }
  }

  private flushAtLastBoundary(): void {
    // Find the LAST sentence terminator so we ship as much complete
    // text as possible without breaking a mid-sentence.
    let cut = -1;
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const c = this.buffer[i]!;
      if (c === "." || c === "!" || c === "?" || c === "\n") {
        cut = i;
        break;
      }
    }
    if (cut < 0) return;
    if (this.startsHold(this.buffer.slice(0, cut + 1))) return;
    const segment = this.buffer.slice(0, cut + 1).trimEnd();
    this.buffer = this.buffer.slice(cut + 1).trimStart();
    if (segment.length > 0) this.emit(segment);
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
      if (this.buffer.length > 0) {
        if (this.startsHold(this.buffer)) return;
        this.emit(this.buffer.trimEnd());
        this.buffer = "";
      }
    }, this.idleMs);
  }

  private emit(text: string): void {
    if (text.length > 0) this.onFlush(text);
  }
}

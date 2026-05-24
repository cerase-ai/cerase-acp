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

export interface StreamBufferOptions {
  onFlush: (text: string) => void;
  /** Min chars before a sentence boundary triggers a flush. Default 200. */
  sentenceMinChars?: number;
  /** Hard cap; flush when reached even if no boundary. Default 1800. */
  maxChars?: number;
  /** Idle timer (ms) after the last push. Default 500. */
  idleMs?: number;
}

const SENTENCE_END = /[.!?\n]/;

export class StreamBuffer {
  private buffer = "";
  private idleTimer?: NodeJS.Timeout;
  private readonly sentenceMinChars: number;
  private readonly maxChars: number;
  private readonly idleMs: number;
  private readonly onFlush: (text: string) => void;
  private ended = false;

  constructor(opts: StreamBufferOptions) {
    this.onFlush = opts.onFlush;
    this.sentenceMinChars = opts.sentenceMinChars ?? 200;
    this.maxChars = opts.maxChars ?? 1800;
    this.idleMs = opts.idleMs ?? 500;
  }

  push(text: string): void {
    if (this.ended || !text) return;
    this.buffer += text;
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
      this.emit(this.buffer);
      this.buffer = "";
    }
  }

  end(): void {
    this.ended = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.buffer.length > 0) {
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
    const segment = this.buffer.slice(0, cut + 1).trimEnd();
    this.buffer = this.buffer.slice(cut + 1).trimStart();
    if (segment.length > 0) this.emit(segment);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.buffer.length > 0) {
        this.emit(this.buffer.trimEnd());
        this.buffer = "";
      }
    }, this.idleMs);
  }

  private emit(text: string): void {
    if (text.length > 0) this.onFlush(text);
  }
}

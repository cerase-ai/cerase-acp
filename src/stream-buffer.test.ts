import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamBuffer } from "./stream-buffer.js";

describe("StreamBuffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes when a sentence boundary is hit AND >= sentenceMinChars accumulated", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({
      onFlush: (s) => out.push(s),
      sentenceMinChars: 20,
      maxChars: 1800,
      idleMs: 500,
    });
    // First chunk: short — no sentence boundary, no flush yet.
    buf.push("hello there. ");
    expect(out).toEqual([]);
    // Add more so total >= 20 then hit a sentence end.
    buf.push("this is a longer chunk. ");
    expect(out).toEqual(["hello there. this is a longer chunk."]);
  });

  it("does NOT flush on a sentence boundary if below sentenceMinChars", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({
      onFlush: (s) => out.push(s),
      sentenceMinChars: 50,
      maxChars: 1800,
      idleMs: 500,
    });
    buf.push("ok. ");
    expect(out).toEqual([]);
    // Force-flush via end() so the remainder lands somewhere observable.
    buf.end();
    expect(out).toEqual(["ok."]);
  });

  it("flushes when buffer exceeds maxChars regardless of boundary", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({
      onFlush: (s) => out.push(s),
      sentenceMinChars: 1_000_000, // disable boundary-based flush
      maxChars: 50,
      idleMs: 500,
    });
    buf.push("x".repeat(60));
    expect(out.length).toBe(1);
    expect(out[0]!.length).toBe(60);
  });

  it("flushes on idle timer after the last push", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({
      onFlush: (s) => out.push(s),
      sentenceMinChars: 1_000_000,
      maxChars: 10_000,
      idleMs: 500,
    });
    buf.push("partial sentence without terminator");
    expect(out).toEqual([]);
    vi.advanceTimersByTime(499);
    expect(out).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(out).toEqual(["partial sentence without terminator"]);
  });

  it("end() flushes any remaining text", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({
      onFlush: (s) => out.push(s),
      sentenceMinChars: 1_000_000,
      maxChars: 10_000,
      idleMs: 500,
    });
    buf.push("trailing without period");
    buf.end();
    expect(out).toEqual(["trailing without period"]);
  });

  it("end() is a no-op when the buffer is empty", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({
      onFlush: (s) => out.push(s),
      sentenceMinChars: 20,
      maxChars: 1800,
      idleMs: 500,
    });
    buf.end();
    expect(out).toEqual([]);
  });

  it("recognises ., !, ?, newline as sentence boundaries", () => {
    for (const terminator of [".", "!", "?", "\n"]) {
      const out: string[] = [];
      const buf = new StreamBuffer({
        onFlush: (s) => out.push(s),
        sentenceMinChars: 5,
        maxChars: 1800,
        idleMs: 500,
      });
      buf.push(`this is enough${terminator} `);
      expect(out.length).toBe(1);
    }
  });

  describe("a buffer that keeps messages whole", () => {
    function whole(holdFrom?: (piece: string) => number) {
      const out: string[] = [];
      const kept: string[] = [];
      const buf = new StreamBuffer({
        onFlush: (s) => out.push(s),
        onHeld: (s) => kept.push(s),
        holdFrom,
        wholeMessages: true,
      });
      return { buf, out, kept };
    }

    it("sends nothing on a sentence end, on the size cap or on the idle timer, and everything at end()", () => {
      const { buf, out } = whole();
      const answer = `${"Prima frase della risposta, abbastanza lunga da contare. ".repeat(40)}Ultima frase.`;
      for (let i = 0; i < answer.length; i += 50) buf.push(answer.slice(i, i + 50));
      vi.advanceTimersByTime(60_000);
      expect(answer.length).toBeGreaterThan(2000);
      expect(out).toEqual([]);
      buf.end();
      expect(out).toEqual([answer]);
    });

    it("sends what it holds on flush(), and what comes after on the next flush()", () => {
      const { buf, out } = whole();
      buf.push("Un attimo, controllo la tua agenda.");
      buf.flush();
      expect(out).toEqual(["Un attimo, controllo la tua agenda."]);
      buf.flush();
      expect(out).toHaveLength(1);
      buf.push("Domani hai due riunioni.");
      buf.end();
      expect(out).toEqual(["Un attimo, controllo la tua agenda.", "Domani hai due riunioni."]);
    });

    it("judges a flush for a hold, and keeps the held text for release()", () => {
      const { buf, out, kept } = whole((piece) => {
        const m = /^HOLD$/m.exec(piece);
        return m ? m.index : -1;
      });
      buf.push("before the hold.\nHOLD\nkept.");
      buf.flush();
      expect(out).toEqual(["before the hold."]);
      buf.flush();
      expect(kept).toEqual([]);
      buf.release();
      expect(kept).toEqual(["HOLD\nkept."]);
    });
  });

  it("flush() on a streaming buffer sends a partial sentence before its idle timer", () => {
    const out: string[] = [];
    const buf = new StreamBuffer({ onFlush: (s) => out.push(s), idleMs: 500 });
    buf.push("partial sentence without terminator");
    buf.flush();
    expect(out).toEqual(["partial sentence without terminator"]);
    vi.advanceTimersByTime(1000);
    expect(out).toHaveLength(1);
  });

  describe("a hold", () => {
    // Stands in for the caller's rule: hold from the first line reading HOLD.
    const holdFrom = (piece: string) => {
      const m = /^HOLD$/m.exec(piece);
      return m ? m.index : -1;
    };

    function held() {
      const out: string[] = [];
      const kept: string[] = [];
      const buf = new StreamBuffer({
        onFlush: (s) => out.push(s),
        onHeld: (s) => kept.push(s),
        holdFrom,
        sentenceMinChars: 20,
        maxChars: 1800,
        idleMs: 500,
      });
      return { buf, out, kept };
    }

    it("flushes what comes before it and keeps the rest, pieces joined as they were pushed", () => {
      const { buf, out, kept } = held();
      buf.push("this part goes out as usual.\nHOLD\nfirst line.\n");
      buf.push("\n  second line, indented.\n");
      expect(out).toEqual(["this part goes out as usual."]);
      expect(kept).toEqual([]);
      buf.end();
      // The blank line and the indent between the two pushes survive: a line
      // start is what the caller's judgement reads.
      expect(kept).toEqual(["HOLD\nfirst line.\n\n  second line, indented."]);
      expect(out).toEqual(["this part goes out as usual."]);
    });

    it("is not ended by the size cap or the idle timer", () => {
      const { buf, out, kept } = held();
      buf.push("HOLD\nsomething to keep.\n");
      buf.push("x".repeat(2000));
      vi.advanceTimersByTime(5_000);
      expect(out).toEqual([]);
      expect(kept).toEqual([]);
      buf.end();
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatch(/^HOLD\nsomething to keep\.\nx{2000}$/);
    });

    it("hands the held text over on release() and then streams as before", () => {
      const { buf, out, kept } = held();
      buf.push("HOLD\nkept until released.\n");
      buf.release();
      expect(kept).toEqual(["HOLD\nkept until released."]);
      buf.push("after the release this flushes normally. ");
      expect(out).toEqual(["after the release this flushes normally."]);
      buf.end();
      expect(kept).toHaveLength(1);
    });

    it("judges the last piece at end() too", () => {
      const { buf, out, kept } = held();
      buf.push("short\nHOLD");
      buf.end();
      expect(out).toEqual(["short"]);
      expect(kept).toEqual(["HOLD"]);
    });

    it("hands held text to onFlush when no onHeld is given", () => {
      const out: string[] = [];
      const buf = new StreamBuffer({ onFlush: (s) => out.push(s), holdFrom, sentenceMinChars: 20 });
      buf.push("HOLD\nall of this is one piece.\n");
      buf.push("and so is this.\n");
      buf.end();
      expect(out).toEqual(["HOLD\nall of this is one piece.\nand so is this."]);
    });
  });
});

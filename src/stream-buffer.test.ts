import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
});

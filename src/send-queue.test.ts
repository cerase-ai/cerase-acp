import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SendQueue, chunkForDiscord, DELIVERY_FAILURE_MARKER } from "./send-queue.js";

describe("chunkForDiscord", () => {
  it("returns one chunk when text fits", () => {
    expect(chunkForDiscord("short message")).toEqual(["short message"]);
  });

  it("does not chunk empty strings", () => {
    expect(chunkForDiscord("")).toEqual([]);
  });

  it("splits on newline boundaries when possible", () => {
    const para1 = "a".repeat(900);
    const para2 = "b".repeat(900);
    const para3 = "c".repeat(900);
    const text = `${para1}\n${para2}\n${para3}`;
    const chunks = chunkForDiscord(text);
    // 2700 chars > 1990 → at least 2 chunks; each ≤ 1990 incl. marker.
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
  });

  it("splits on sentence boundaries when no newlines exist", () => {
    const sentence = "x".repeat(500) + ". ";
    const text = sentence.repeat(5); // 2510 chars in 5 sentences
    const chunks = chunkForDiscord(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
  });

  it("hard-splits when no nice boundary fits in the budget", () => {
    const text = "y".repeat(5000);
    const chunks = chunkForDiscord(text);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
    // Reassembling drops continuation markers — verify no characters
    // were lost from the payload itself.
    const reassembled = chunks.map((c) => c.replace(/ ⏎$/u, "")).join("");
    expect(reassembled).toBe(text);
  });

  it("appends a continuation marker on every non-final chunk", () => {
    const text = "z".repeat(5000);
    const chunks = chunkForDiscord(text);
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i]!.endsWith(" ⏎")).toBe(true);
    }
    expect(chunks.at(-1)!.endsWith(" ⏎")).toBe(false);
  });
});

describe("SendQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers messages in FIFO order to the sender", async () => {
    const sent: string[] = [];
    const q = new SendQueue({
      send: async (msg) => {
        sent.push(msg);
      },
      minIntervalMs: 100,
    });
    q.enqueue("first");
    q.enqueue("second");
    q.enqueue("third");
    await vi.advanceTimersByTimeAsync(500);
    await q.drain();
    expect(sent).toEqual(["first", "second", "third"]);
  });

  it("spaces sends by at least minIntervalMs", async () => {
    const timestamps: number[] = [];
    const q = new SendQueue({
      send: async () => {
        timestamps.push(Date.now());
      },
      minIntervalMs: 100,
    });
    const t0 = Date.now();
    q.enqueue("a");
    q.enqueue("b");
    q.enqueue("c");
    await vi.advanceTimersByTimeAsync(500);
    await q.drain();
    expect(timestamps.length).toBe(3);
    expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(100);
    expect(timestamps[2]! - timestamps[1]!).toBeGreaterThanOrEqual(100);
    void t0;
  });

  it("auto-chunks messages > 1990 chars before dispatch", async () => {
    const sent: string[] = [];
    const q = new SendQueue({
      send: async (msg) => {
        sent.push(msg);
      },
      minIntervalMs: 100,
    });
    q.enqueue("z".repeat(5000));
    await vi.advanceTimersByTimeAsync(2000);
    await q.drain();
    expect(sent.length).toBeGreaterThanOrEqual(3);
    for (const c of sent) expect(c.length).toBeLessThanOrEqual(2000);
  });

  it("continues after a send() throws — rest of the queue still drains", async () => {
    const sent: string[] = [];
    const q = new SendQueue({
      send: async (msg) => {
        if (msg === "fail") throw new Error("network error");
        sent.push(msg);
      },
      minIntervalMs: 50,
    });
    q.enqueue("ok-1");
    q.enqueue("fail");
    q.enqueue("ok-2");
    await vi.advanceTimersByTimeAsync(2_000);
    await q.drain();
    // M-ACP-2: the permanently-failing chunk is retried once, then a
    // visible delivery-failure marker is emitted; the queue continues.
    expect(sent).toEqual(["ok-1", DELIVERY_FAILURE_MARKER, "ok-2"]);
  });
});

// M-ACP-2 — a failed chunk is retried once; persistent failure emits a
// visible delivery-failure marker instead of silently dropping mid-reply
// content (the user used to see a reply with a hole in it).
describe("SendQueue delivery retry (M-ACP-2)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retries a failed chunk once and delivers it", async () => {
    const received: string[] = [];
    let failures = 1;
    const q = new SendQueue({
      send: async (text) => {
        if (failures > 0) {
          failures--;
          throw new Error("platform hiccup");
        }
        received.push(text);
      },
    });
    q.enqueue("hello");
    await vi.advanceTimersByTimeAsync(5_000);
    await q.drain();
    expect(received).toEqual(["hello"]);
  });

  it("emits the delivery-failure marker once when the retry also fails", async () => {
    const received: string[] = [];
    let failures = 2; // first attempt + retry of chunk 1
    const q = new SendQueue({
      send: async (text) => {
        if (failures > 0) {
          failures--;
          throw new Error("platform down");
        }
        received.push(text);
      },
    });
    q.enqueue("lost chunk");
    q.enqueue("second chunk");
    await vi.advanceTimersByTimeAsync(10_000);
    await q.drain();
    expect(received).toContain(DELIVERY_FAILURE_MARKER);
    expect(received).toContain("second chunk");
    expect(received).not.toContain("lost chunk");
    expect(received.filter((t) => t === DELIVERY_FAILURE_MARKER).length).toBe(1);
  });
});

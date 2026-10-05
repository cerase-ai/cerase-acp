import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chunkForDiscord, DELIVERY_FAILURE_MARKER, SEND_RETRY_DELAYS_MS, SendQueue } from "./send-queue.js";

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
    const sentence = `${"x".repeat(500)}. `;
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
        return { ok: true };
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
        return { ok: true };
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
        return { ok: true };
      },
      minIntervalMs: 100,
    });
    q.enqueue("z".repeat(5000));
    await vi.advanceTimersByTimeAsync(2000);
    await q.drain();
    expect(sent.length).toBeGreaterThanOrEqual(3);
    for (const c of sent) expect(c.length).toBeLessThanOrEqual(2000);
  });

  it("continues after a send() reports failure — rest of the queue still drains", async () => {
    const sent: string[] = [];
    const q = new SendQueue({
      // The send target reports failure instead of throwing.
      send: async (msg) => {
        if (msg === "fail") return { ok: false, error: new Error("network error") };
        sent.push(msg);
        return { ok: true };
      },
      minIntervalMs: 50,
    });
    q.enqueue("ok-1");
    q.enqueue("fail");
    q.enqueue("ok-2");
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await q.drain();
    // The permanently-failing chunk is retried, then a visible
    // delivery-failure marker is emitted; the queue continues.
    expect(sent).toEqual(["ok-1", DELIVERY_FAILURE_MARKER, "ok-2"]);
    // drain() reports the failure so the dispatcher fails loud.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]!.chunk).toBe("fail");
    }
  });

  it("still continues + emits the marker if the send target THROWS (defensive)", async () => {
    const sent: string[] = [];
    const q = new SendQueue({
      // A target that throws instead of returning is caught defensively and
      // treated as a `!ok` result.
      send: async (msg) => {
        if (msg === "boom") throw new Error("network error");
        sent.push(msg);
        return { ok: true };
      },
      minIntervalMs: 50,
    });
    q.enqueue("ok-1");
    q.enqueue("boom");
    q.enqueue("ok-2");
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await q.drain();
    expect(sent).toEqual(["ok-1", DELIVERY_FAILURE_MARKER, "ok-2"]);
    expect(result.ok).toBe(false);
  });

  it("drain() reports ok when every chunk is delivered", async () => {
    const q = new SendQueue({
      send: async () => ({ ok: true }),
      minIntervalMs: 50,
    });
    q.enqueue("a");
    q.enqueue("b");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(q.drain()).resolves.toEqual({ ok: true });
  });
});

// A refused chunk is tried again, waiting longer each time; one the channel
// keeps refusing is reported with a visible delivery-failure marker instead of
// being silently dropped mid-reply (the user used to see a reply with a hole
// in it).
describe("SendQueue delivery retry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A target that refuses the first `refusals` sends, recording when each was tried. */
  function refusing(refusals: number) {
    const tried: number[] = [];
    const received: string[] = [];
    let left = refusals;
    const send = async (text: string) => {
      tried.push(Date.now());
      if (left > 0) {
        left -= 1;
        return { ok: false as const, error: new Error("platform hiccup") };
      }
      received.push(text);
      return { ok: true as const };
    };
    return { send, tried, received };
  }

  it("tries a refused chunk again after each backoff delay, longer each time, and delivers it", async () => {
    expect(SEND_RETRY_DELAYS_MS.length).toBeGreaterThan(1);
    for (let i = 1; i < SEND_RETRY_DELAYS_MS.length; i++) {
      expect(SEND_RETRY_DELAYS_MS[i]!).toBeGreaterThan(SEND_RETRY_DELAYS_MS[i - 1]!);
    }
    const target = refusing(SEND_RETRY_DELAYS_MS.length);
    const q = new SendQueue({ send: target.send });
    q.enqueue("hello");
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(q.drain()).resolves.toEqual({ ok: true });
    expect(target.received).toEqual(["hello"]);
    const waits = target.tried.slice(1).map((t, i) => t - target.tried[i]!);
    expect(waits).toEqual(SEND_RETRY_DELAYS_MS);
  });

  it("gives the chunk up after the last retry and sends the marker once", async () => {
    const target = refusing(SEND_RETRY_DELAYS_MS.length + 1);
    const q = new SendQueue({ send: target.send });
    q.enqueue("lost chunk");
    q.enqueue("second chunk");
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await q.drain();

    expect(target.received).toEqual([DELIVERY_FAILURE_MARKER, "second chunk"]);
    // The lost chunk is reported by drain().
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.map((f) => f.chunk)).toEqual(["lost chunk"]);
    }
  });

  it("tries the rest of the reply once each after a chunk was lost, without the backoff again", async () => {
    // A channel that has refused a chunk through the whole backoff is down:
    // waiting the backoff again for every later chunk would hold the end of
    // the turn for the length of the answer.
    const target = refusing(Number.POSITIVE_INFINITY);
    const q = new SendQueue({ send: target.send });
    q.enqueue("first");
    q.enqueue("second");
    q.enqueue("third");
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await q.drain();

    // Every try of the first chunk, then the marker, the second and the third once each.
    expect(target.tried).toHaveLength(SEND_RETRY_DELAYS_MS.length + 1 + 3);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.map((f) => f.chunk)).toEqual(["first", DELIVERY_FAILURE_MARKER, "second", "third"]);
    }
  });
});

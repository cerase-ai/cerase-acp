import { describe, it, expect } from "vitest";
import { PromptQueue } from "./prompt-queue.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("PromptQueue", () => {
  it("processes enqueued items in FIFO order", async () => {
    const q = new PromptQueue();
    const order: number[] = [];
    const p1 = q.enqueue(async () => {
      await sleep(20);
      order.push(1);
      return "first";
    });
    const p2 = q.enqueue(async () => {
      order.push(2);
      return "second";
    });
    const p3 = q.enqueue(async () => {
      order.push(3);
      return "third";
    });
    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual(["first", "second", "third"]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("does not start the second handler until the first has resolved", async () => {
    const q = new PromptQueue();
    let firstStarted = false;
    let firstFinished = false;
    let secondStartedBeforeFirstFinished = false;
    const p1 = q.enqueue(async () => {
      firstStarted = true;
      await sleep(30);
      firstFinished = true;
    });
    const p2 = q.enqueue(async () => {
      if (!firstFinished) secondStartedBeforeFirstFinished = true;
    });
    await Promise.all([p1, p2]);
    expect(firstStarted).toBe(true);
    expect(firstFinished).toBe(true);
    expect(secondStartedBeforeFirstFinished).toBe(false);
  });

  it("rejects the failing handler's promise but continues to the next item", async () => {
    const q = new PromptQueue();
    const p1 = q.enqueue(async () => {
      throw new Error("boom");
    });
    const p2 = q.enqueue(async () => "ok");
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).resolves.toBe("ok");
  });

  it("size() reports queued + in-flight count, drains to 0 when idle", async () => {
    const q = new PromptQueue();
    expect(q.size()).toBe(0);
    let release: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const p1 = q.enqueue(async () => {
      await gate;
    });
    const p2 = q.enqueue(async () => {});
    expect(q.size()).toBe(2);
    release!();
    await Promise.all([p1, p2]);
    expect(q.size()).toBe(0);
  });
});

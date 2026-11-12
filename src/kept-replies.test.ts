// A reply its channel could not carry is kept, and sent once the channel can:
// each once, a person's in the order they were written.

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeliveryResult } from "./chat-adapter.js";
import { KEPT_REPLIES_FILE, KeptReplies } from "./kept-replies.js";
import { specTest } from "./test-support/spec-rows.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kept-replies-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ok = async (): Promise<DeliveryResult> => ({ ok: true });

describe("KeptReplies", () => {
  specTest(
    "ACP-REPLY-012",
    "sends a person's kept replies once each, oldest first, when the channel can carry them",
    async (row) => {
      const kept = new KeptReplies(dir);
      kept.keep("agent-1", "111", "prima");
      kept.keep("agent-1", "222", "per un altro");
      kept.keep("agent-1", "111", "seconda");
      const sent: string[] = [];
      const n = await kept.deliver(
        "agent-1",
        "111",
        async (t) => {
          sent.push(t);
          return { ok: true };
        },
        () => true,
      );
      expect(n).toBe(2);
      expect(sent).toEqual(["prima", "seconda"]);
      expect(kept.has("agent-1", "111")).toBe(false);
      expect(kept.has("agent-1", "222")).toBe(true);
      expect(await kept.deliver("agent-1", "111", ok, () => true)).toBe(0);

      const onceEach = n === 2 && sent.length === 2 && new Set(sent).size === 2;
      const oldestFirst = sent[0] === "prima" && sent[1] === "seconda";
      const observed = `they are sent ${onceEach ? "once each" : "more than once each"}, ${oldestFirst ? "oldest first" : "newest first"}`;
      expect(observed).toBe(row.expect);
    },
  );

  it("sends nothing while the channel cannot carry, and keeps everything", async () => {
    const kept = new KeptReplies(dir);
    kept.keep("agent-1", "111", "prima");
    let calls = 0;
    const n = await kept.deliver(
      "agent-1",
      "111",
      async () => {
        calls += 1;
        return { ok: true };
      },
      () => false,
    );
    expect(n).toBe(0);
    expect(calls).toBe(0);
    expect(kept.has("agent-1", "111")).toBe(true);
  });

  specTest(
    "ACP-REPLY-013",
    "puts a reply back first in line when the channel goes again while it is sent, and stops",
    async (row) => {
      const kept = new KeptReplies(dir);
      kept.keep("agent-1", "111", "prima");
      kept.keep("agent-1", "111", "seconda");
      let up = true;
      const n = await kept.deliver(
        "agent-1",
        "111",
        async () => {
          up = false;
          return { ok: false, error: new Error("Expected token to be set for this request") };
        },
        () => up,
      );
      expect(n).toBe(0);
      const sent: string[] = [];
      await kept.deliver(
        "agent-1",
        "111",
        async (t) => {
          sent.push(t);
          return { ok: true };
        },
        () => true,
      );
      expect(sent).toEqual(["prima", "seconda"]);

      const backFirst = sent[0] === "prima" && sent[1] === "seconda";
      const stops = n === 0;
      const observed = `the reply ${backFirst ? "goes back first in line" : "does not go back first in line"} and the delivery ${stops ? "stops" : "continues"}`;
      expect(observed).toBe(row.expect);
    },
  );

  it("drops a reply the channel refuses while it can carry, rather than trying it for ever, and goes on", async () => {
    const kept = new KeptReplies(dir);
    kept.keep("agent-1", "111", "rifiutata");
    kept.keep("agent-1", "111", "seconda");
    const sent: string[] = [];
    const n = await kept.deliver(
      "agent-1",
      "111",
      async (t) => {
        if (t === "rifiutata") return { ok: false, error: new Error("Invalid Form Body") };
        sent.push(t);
        return { ok: true };
      },
      () => true,
    );
    expect(n).toBe(1);
    expect(sent).toEqual(["seconda"]);
    expect(kept.has("agent-1", "111")).toBe(false);
  });

  it("runs two deliveries for one person one after the other, so none is sent twice or out of order", async () => {
    const kept = new KeptReplies(dir);
    for (const t of ["uno", "due", "tre"]) kept.keep("agent-1", "111", t);
    const sent: string[] = [];
    const slowly = async (t: string): Promise<DeliveryResult> => {
      await new Promise((r) => setTimeout(r, 5));
      sent.push(t);
      return { ok: true };
    };
    const first = kept.deliver("agent-1", "111", slowly, () => true);
    expect(kept.pending("agent-1", "111")).toBe(true);
    const second = kept.deliver("agent-1", "111", slowly, () => true);
    await Promise.all([first, second]);
    expect(sent).toEqual(["uno", "due", "tre"]);
    expect(kept.pending("agent-1", "111")).toBe(false);
  });

  it("is written to the state directory, readable only by the bridge, and read back by the next bridge", async () => {
    new KeptReplies(dir).keep("agent-1", "111", "sopravvive al riavvio");
    expect(statSync(join(dir, KEPT_REPLIES_FILE)).mode & 0o777).toBe(0o600);
    const next = new KeptReplies(dir);
    expect(next.people("agent-1")).toEqual(["111"]);
    expect(next.agents()).toEqual(["agent-1"]);
    const sent: string[] = [];
    await next.deliver(
      "agent-1",
      "111",
      async (t) => {
        sent.push(t);
        return { ok: true };
      },
      () => true,
    );
    expect(sent).toEqual(["sopravvive al riavvio"]);
    expect(JSON.parse(readFileSync(join(dir, KEPT_REPLIES_FILE), "utf8"))).toEqual({ replies: [] });
  });

  specTest("ACP-REPLY-014", "forgets an agent's replies when the agent is gone", (row) => {
    const kept = new KeptReplies(dir);
    kept.keep("agent-1", "111", "a");
    kept.keep("agent-2", "111", "b");
    const removed = kept.forget("agent-1");
    expect(removed).toBe(1);
    expect(kept.agents()).toEqual(["agent-2"]);
    expect(new KeptReplies(dir).agents()).toEqual(["agent-2"]);

    const forgotten = removed === 1;
    const goneInMemory = !kept.agents().includes("agent-1");
    const goneOnDisk = !new KeptReplies(dir).agents().includes("agent-1");
    const observed = `its kept replies are ${forgotten && goneInMemory && goneOnDisk ? "forgotten" : "kept"}`;
    expect(observed).toBe(row.expect);
  });

  it("keeps replies in memory when there is no state directory", async () => {
    const kept = new KeptReplies(undefined);
    kept.keep("agent-1", "111", "in memoria");
    expect(kept.has("agent-1", "111")).toBe(true);
    expect(await kept.deliver("agent-1", "111", ok, () => true)).toBe(1);
  });
});

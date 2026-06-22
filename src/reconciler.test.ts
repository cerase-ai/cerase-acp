import { describe, expect, it } from "vitest";
import { type CanonicalMessage, reconcile, type SeenState } from "./reconciler.js";

const mkMsg = (parts: Array<{ type: "text" | "reasoning"; text: string; ignored?: boolean }>): CanonicalMessage => ({
  id: "msg_test",
  parts: parts.map((p, i) => ({
    id: `prt_${i}`,
    type: p.type,
    text: p.text,
    ignored: p.ignored ?? false,
  })),
});

describe("reconciler", () => {
  it("returns nothing when seen == canonical", () => {
    const message = mkMsg([
      { type: "reasoning", text: "thinking..." },
      { type: "text", text: "hello world" },
    ]);
    const seen: SeenState = { textSeen: "hello world", reasoningSeen: "thinking..." };
    expect(reconcile(seen, message)).toEqual([]);
  });

  it("returns the tail of text when seen is a prefix of canonical", () => {
    const message = mkMsg([{ type: "text", text: "hello world" }]);
    const seen: SeenState = { textSeen: "hello", reasoningSeen: "" };
    expect(reconcile(seen, message)).toEqual([{ kind: "text", text: " world" }]);
  });

  it("returns the tail of reasoning when seen reasoning is a prefix", () => {
    const message = mkMsg([
      { type: "reasoning", text: "step 1; step 2" },
      { type: "text", text: "done" },
    ]);
    const seen: SeenState = { textSeen: "done", reasoningSeen: "step 1;" };
    expect(reconcile(seen, message)).toEqual([{ kind: "reasoning", text: " step 2" }]);
  });

  it("emits both text and reasoning tails together when both are short", () => {
    const message = mkMsg([
      { type: "reasoning", text: "rrrrrr" },
      { type: "text", text: "tttttt" },
    ]);
    const seen: SeenState = { textSeen: "ttt", reasoningSeen: "rrr" };
    const result = reconcile(seen, message);
    expect(result).toContainEqual({ kind: "reasoning", text: "rrr" });
    expect(result).toContainEqual({ kind: "text", text: "ttt" });
    expect(result.length).toBe(2);
  });

  it("concatenates multiple parts of the same kind before diffing", () => {
    // opencode can emit multiple text parts within one assistant message
    // (e.g., one before a tool call and one after). The visible reply is
    // their concatenation, so seen vs canonical must compare the joined
    // string, not part-by-part.
    const message = mkMsg([
      { type: "text", text: "part-1 " },
      { type: "reasoning", text: "thought between" },
      { type: "text", text: "part-2 end" },
    ]);
    const seen: SeenState = {
      textSeen: "part-1 part",
      reasoningSeen: "thought between",
    };
    expect(reconcile(seen, message)).toEqual([{ kind: "text", text: "-2 end" }]);
  });

  it("skips text parts marked ignored (matches opencode's own delta path)", () => {
    // The opencode acp delta emitter at agent.ts:466 only sends parts
    // with `ignored !== true`. Our canonical reconstruction must match
    // that, otherwise we'd emit "reconciled" content the client never
    // should have seen.
    const message = mkMsg([
      { type: "text", text: "skip-me", ignored: true },
      { type: "text", text: "keep" },
    ]);
    const seen: SeenState = { textSeen: "", reasoningSeen: "" };
    expect(reconcile(seen, message)).toEqual([{ kind: "text", text: "keep" }]);
  });

  it("returns nothing when seen is longer than canonical (unexpected — log + skip)", () => {
    // Conservative: if our delta tracker saw MORE bytes than the
    // canonical record contains, something's off (out-of-order or
    // bug). Better to under-report than duplicate visible text.
    const message = mkMsg([{ type: "text", text: "hi" }]);
    const seen: SeenState = { textSeen: "hi-extra", reasoningSeen: "" };
    expect(reconcile(seen, message)).toEqual([]);
  });

  it("returns nothing for non-text non-reasoning parts (tool, file, step) — they aren't streamed as chunks", () => {
    const message: CanonicalMessage = {
      id: "msg_test",
      parts: [
        { id: "prt_0", type: "tool", text: "", ignored: false },
        { id: "prt_1", type: "step_start", text: "", ignored: false },
        { id: "prt_2", type: "text", text: "result" },
      ],
    };
    const seen: SeenState = { textSeen: "result", reasoningSeen: "" };
    expect(reconcile(seen, message)).toEqual([]);
  });
});

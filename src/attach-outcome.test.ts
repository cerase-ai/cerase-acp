import { describe, expect, it } from "vitest";
import { AttachOutcomeTracker, attachFailureError, attachFailurePrompt } from "./attach-outcome.js";

describe("AttachOutcomeTracker", () => {
  it("keeps failures per pair and forgets them once the turn has read them", () => {
    const t = new AttachOutcomeTracker();
    t.begin("doc-qa", "111");
    t.record("doc-qa", "111", { fileName: "deck.pdf", reason: "not found" });
    t.record("doc-qa", "111", { fileName: "notes.md", reason: "channel refused it" });
    // Another conversation's failure is not this one's.
    t.record("doc-qa", "222", { fileName: "other.pdf", reason: "not found" });

    const taken = t.take("doc-qa", "111");
    expect(taken.map((f) => f.fileName)).toEqual(["deck.pdf", "notes.md"]);
    expect(t.take("doc-qa", "111")).toEqual([]);
    expect(t.take("doc-qa", "222")).toHaveLength(1);
  });

  it("drops what an earlier turn left behind, so a clean turn stays clean", () => {
    const t = new AttachOutcomeTracker();
    t.record("doc-qa", "111", { fileName: "stale.pdf", reason: "not found" });
    t.begin("doc-qa", "111");
    expect(t.take("doc-qa", "111")).toEqual([]);
  });
});

describe("attachFailurePrompt", () => {
  it("names every file and its reason, and forbids the claim that shipped", () => {
    const p = attachFailurePrompt([
      { fileName: "falco-presentation.pdf", reason: "ambiguous workspace path" },
      { fileName: "notes.md", reason: "the channel refused the upload" },
    ]);
    expect(p).toContain("falco-presentation.pdf: ambiguous workspace path");
    expect(p).toContain("notes.md: the channel refused the upload");
    expect(p).toMatch(/did NOT reach/);
    expect(p).toMatch(/Do not claim delivery/);
    // A correction that attaches again would fail again and be dropped, so the
    // instruction has to keep the marker out of it.
    expect(p).toMatch(/do not emit an attach marker/i);
  });
});

describe("attachFailureError", () => {
  it("carries the file names into the turn's own result", () => {
    const e = attachFailureError([{ fileName: "deck.pdf", reason: "not found" }]);
    expect(e.message).toContain("deck.pdf");
    expect(e.message).toMatch(/never reached/);
  });
});

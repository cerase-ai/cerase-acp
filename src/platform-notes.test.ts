import { describe, expect, it } from "vitest";
import { isBridgePrompt } from "./bridge-prompt.js";
import { platformNotesNote, withPlatformNotes } from "./platform-notes.js";

// The platform posts a notice in the person's chat — a button to reconnect a
// service — and the assistant has to know it did, or it offers the same thing
// again. The control-plane hands each note over once, with the turn context,
// and the bridge puts it in front of that turn as a prompt of its own.

describe("the notes the platform leaves about a notice it posted", () => {
  it("opens with the line the console recognises as the bridge's, and carries every note in order", () => {
    const note = platformNotesNote(["the first notice", "the second notice"]);

    expect(note).toBeDefined();
    expect(isBridgePrompt(note!)).toBe(true);
    expect(note!.split("\n")[0]).toBe("[notice_result: posted]");
    expect(note).toContain("the first notice\n\nthe second notice");
    expect(note!).toContain("the first notice");
    expect(note!).toContain("the second notice");
    expect(note!.indexOf("the first notice")).toBeLessThan(note!.indexOf("the second notice"));
  });

  it("is nothing when the platform left no note", () => {
    expect(platformNotesNote([])).toBeUndefined();
  });

  it("goes in front of the turn's other context, and nowhere without notes", () => {
    const note = platformNotesNote(["a notice"])!;

    expect(withPlatformNotes([], undefined)).toBeUndefined();
    expect(withPlatformNotes([], "links")).toBe("links");
    expect(withPlatformNotes(["a notice"], undefined)).toBe(note);
    expect(withPlatformNotes(["a notice"], "links")).toBe(`${note}\n\nlinks`);
  });
});

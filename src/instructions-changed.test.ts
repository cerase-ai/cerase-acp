import { describe, expect, it } from "vitest";
import { isBridgePrompt } from "./bridge-prompt.js";
import { instructionsChangedNote, withInstructionsChanged } from "./instructions-changed.js";
import { fetchTurnContext, resetTurnContextCache } from "./turn-context.js";

// On the first turn after an assistant's instructions or skills change, the
// assistant is told so. On lt-name-1, with v0.1.10-rc.4, two assistants in
// conversations begun under an earlier release followed what they had done
// earlier in the conversation over their new instructions: a quote's revision
// made as the previous one, with no stage of the method read again, and a reply
// that reused a draft signed with the person's name. The new rules were in both
// system prompts. The control-plane decides that the instructions changed after
// the conversation's last message (turn-context's `instructions_changed`); the
// bridge says it, once, in front of the turn.

const OPTS = { controlPlaneUrl: "http://cp:8000", internalSecret: "s3cret" };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("an assistant told that its instructions changed", () => {
  it("reads the control-plane's answer, and takes a missing one as no change", async () => {
    resetTurnContextCache();
    const answer = (changed: Record<string, unknown>) =>
      (async () =>
        jsonResponse({
          timezone: "Europe/Rome",
          now: "2026-10-10T10:00:00+02:00",
          last_turn_at: null,
          ...changed,
        })) as unknown as typeof fetch;

    const changed = await fetchTurnContext(
      "a",
      { platformUserId: "u" },
      { ...OPTS, fetchImpl: answer({ instructions_changed: true }) },
    );
    const same = await fetchTurnContext(
      "a",
      { platformUserId: "u" },
      { ...OPTS, fetchImpl: answer({ instructions_changed: false }) },
    );
    const older = await fetchTurnContext("a", { platformUserId: "u" }, { ...OPTS, fetchImpl: answer({}) });

    expect([changed.instructionsChanged, same.instructionsChanged, older.instructionsChanged]).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("says they changed after the conversation's last message, to follow them as they are now, and to load a skill again", () => {
    const note = instructionsChangedNote();

    expect(isBridgePrompt(note)).toBe(true);
    expect(note.split("\n")[0]).toBe("[instructions_result: changed]");
    expect(note).toContain("changed after the last message of this conversation");
    expect(note).toContain("follow your instructions as they are now");
    expect(note).toContain("load a skill again before you use it");
  });

  it("goes in front of the turn's other context, and nowhere when nothing changed", () => {
    expect(withInstructionsChanged(false, undefined)).toBeUndefined();
    expect(withInstructionsChanged(false, "links")).toBe("links");
    expect(withInstructionsChanged(true, undefined)).toBe(instructionsChangedNote());
    expect(withInstructionsChanged(true, "links")).toBe(`${instructionsChangedNote()}\n\nlinks`);
  });
});

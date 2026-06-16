import { describe, it, expect } from "vitest";
import { isInternalSummaryBlock, redactEngineIdentifiers } from "./egress-redaction.js";

describe("M-AGENT-VOICE-1: egress engine-identity redaction", () => {
  it("never leaves the bare engine name in a reply", () => {
    expect(redactEngineIdentifiers("Giro su OpenCode.")).not.toMatch(/open\s*code/i);
    expect(redactEngineIdentifiers("I run on opencode")).not.toMatch(/open\s*code/i);
    expect(redactEngineIdentifiers("powered by Open Code")).not.toMatch(/open\s*code/i);
  });

  it("replaces the engine name with Cerase", () => {
    expect(redactEngineIdentifiers("Giro su OpenCode.")).toBe("Giro su Cerase.");
  });

  it("scrubs version + config-path + built-in identifiers", () => {
    expect(redactEngineIdentifiers("set OPENCODE_VERSION=1.15.13")).not.toContain("OPENCODE_VERSION");
    expect(redactEngineIdentifiers("edit .opencode/skills/x")).not.toContain(".opencode");
    expect(redactEngineIdentifiers("use the customize-opencode skill")).not.toContain("customize-opencode");
  });

  it("leaves ordinary replies untouched", () => {
    const reply = "Ciao Paolo, ho creato il task e te lo confermo.";
    expect(redactEngineIdentifiers(reply)).toBe(reply);
  });

  it("is idempotent and safe on empty input", () => {
    expect(redactEngineIdentifiers("")).toBe("");
    const once = redactEngineIdentifiers("on OpenCode");
    expect(redactEngineIdentifiers(once)).toBe(once);
  });
});

describe("M-AGENT-SUMMARY-LEAK-1: internal compaction-summary suppression", () => {
  // The actual leaked block: section headers + a masked PII token + paths.
  const summary = [
    "Anchored Summary",
    "The user asked for a story and a plan.",
    "Constraints & Preferences: write in Italian for <nome lfyo>.",
    "Active Tools & State: cerase-tasks idle.",
    "Next Actions: create the project, then the parts.",
    "Technical Notes: PDF render pending.",
    "Workspace Paths & Files: /root/cerase/workspace/story.md",
  ].join("\n\n");

  it("detects the full session-summary block", () => {
    expect(isInternalSummaryBlock(summary)).toBe(true);
  });

  it("detects the block by its title alone (format drift tolerance)", () => {
    expect(isInternalSummaryBlock("Anchored Summary\nshort state dump")).toBe(true);
  });

  it("detects a block missing the title but carrying >=3 section headers", () => {
    const noTitle = "Constraints & Preferences: x\nNext Actions: y\nTechnical Notes: z";
    expect(isInternalSummaryBlock(noTitle)).toBe(true);
  });

  it("never withholds an ordinary reply", () => {
    expect(isInternalSummaryBlock("Ciao Paolo, ho creato il task e te lo confermo.")).toBe(false);
    // A single casual section-like phrase is not enough.
    expect(isInternalSummaryBlock("Le prossime azioni (next actions) sono due.")).toBe(false);
  });

  it("a leaked summary must never reach the user with its PII token", () => {
    // The bug: this block was forwarded verbatim incl. <nome lfyo>. It must be
    // classified as internal (→ the bridge withholds it), so the token is dropped.
    expect(summary).toContain("<nome lfyo>");
    expect(isInternalSummaryBlock(summary)).toBe(true);
  });

  it("is safe on empty/whitespace input", () => {
    expect(isInternalSummaryBlock("")).toBe(false);
    expect(isInternalSummaryBlock("   \n  ")).toBe(false);
  });
});

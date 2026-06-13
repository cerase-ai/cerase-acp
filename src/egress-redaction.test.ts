import { describe, it, expect } from "vitest";
import { redactEngineIdentifiers } from "./egress-redaction.js";

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

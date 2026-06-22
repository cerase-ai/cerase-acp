import { describe, expect, it } from "vitest";
import { isSafeWorkspacePath, parseAttachments } from "./attachment.js";

describe("parseAttachments", () => {
  it("extracts a single [[attach: path]] marker and strips it from the text", () => {
    const out = parseAttachments("Eccola! [[attach: storia-bambini.md]]");
    expect(out.attachments).toEqual(["storia-bambini.md"]);
    expect(out.text).toBe("Eccola!");
  });

  it("extracts multiple markers and keeps the surrounding text clean", () => {
    const out = parseAttachments("Ho due file [[attach: a.md]] e [[attach: out/b.pdf]] pronti.");
    expect(out.attachments).toEqual(["a.md", "out/b.pdf"]);
    expect(out.text).toBe("Ho due file  e  pronti.".replace(/\s+/g, " ").trim());
  });

  it("tolerates whitespace inside the marker", () => {
    const out = parseAttachments("x [[ attach :  report.md ]] y");
    expect(out.attachments).toEqual(["report.md"]);
  });

  it("rejects absolute paths and .. traversal (dropped, not attached)", () => {
    const out = parseAttachments("a [[attach: /etc/passwd]] b [[attach: ../secret]] c [[attach: ok.md]]");
    expect(out.attachments).toEqual(["ok.md"]);
    expect(out.text).not.toContain("attach");
  });

  it("leaves text with no markers untouched", () => {
    const out = parseAttachments("nessun allegato qui");
    expect(out.attachments).toEqual([]);
    expect(out.text).toBe("nessun allegato qui");
  });

  it("isSafeWorkspacePath guards traversal + absolute", () => {
    expect(isSafeWorkspacePath("a/b.md")).toBe(true);
    expect(isSafeWorkspacePath("file.md")).toBe(true);
    expect(isSafeWorkspacePath("/abs")).toBe(false);
    expect(isSafeWorkspacePath("../x")).toBe(false);
    expect(isSafeWorkspacePath("a/../../x")).toBe(false);
    expect(isSafeWorkspacePath("")).toBe(false);
  });
});

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

  // A marker that names no file the bridge may send still promised the person
  // one: it is taken out of the text and reported, so they are told and the
  // turn does not close as delivered.
  it("reports a path outside the workspace instead of dropping it silently", () => {
    const out = parseAttachments("a [[attach: /etc/passwd]] b [[attach: ../secret]] c [[attach: ok.md]]");
    expect(out.refused.map((r) => r.name)).toEqual(["passwd", "secret"]);
    for (const r of out.refused) expect(r.reason).toMatch(/outside the workspace/);
  });

  it("removes and reports a marker that names no file", () => {
    for (const reply of ["Eccolo [[attach: ]]", "Eccolo [[attach:]]"]) {
      const out = parseAttachments(reply);
      expect(out.text).toBe("Eccolo");
      expect(out.attachments).toEqual([]);
      expect(out.refused).toEqual([{ name: "", reason: expect.stringMatching(/names no file/) }]);
    }
  });

  it("removes and reports a marker left open at the end of the text", () => {
    const out = parseAttachments("Ecco il report. [[attach: outputs/report.");
    expect(out.text).toBe("Ecco il report.");
    expect(out.attachments).toEqual([]);
    expect(out.refused).toEqual([{ name: "report", reason: expect.stringMatching(/not closed/) }]);
  });

  it("removes a marker that is not closed up to where its line ends, keeping the next line", () => {
    const out = parseAttachments("Ecco [[attach: outputs/a.pdf] il file\nE la riga dopo.");
    expect(out.text).toBe("Ecco il file\nE la riga dopo.");
    expect(out.refused).toEqual([{ name: "a.pdf", reason: expect.stringMatching(/not closed/) }]);
  });

  it("removes the tail of a marker cut before it, which was reported with its head", () => {
    const out = parseAttachments("pdf]] e il resto");
    expect(out.text).toBe("e il resto");
    expect(out.refused).toEqual([]);
  });

  it("hands back a text with no marker exactly as it was, spaces and all", () => {
    const reply = "  due  spazi\n\n```\nx  =  1\n```  ";
    expect(parseAttachments(reply).text).toBe(reply);
  });

  it("leaves text with no markers untouched", () => {
    const out = parseAttachments("nessun allegato qui");
    expect(out.attachments).toEqual([]);
    expect(out.refused).toEqual([]);
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

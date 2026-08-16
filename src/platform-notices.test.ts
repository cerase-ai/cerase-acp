import { describe, expect, it } from "vitest";
import { pickEmptyMessage, pickErrorMessage, pickNoCreditsMessage, pickRefusalMessage } from "./dispatcher.js";
import {
  attachmentFailedNotice,
  attachmentsUnsupportedNotice,
  attachmentUnreadableNotice,
  deliveryFailureNotice,
  displayFileName,
  oversizeUploadNotice,
} from "./platform-notices.js";
import { TurnMetaTracker } from "./turn-meta.js";

const ALL = [attachmentFailedNotice, attachmentUnreadableNotice, attachmentsUnsupportedNotice];

describe("platform notices", () => {
  it("speaks the reader's language, not always Italian", () => {
    expect(attachmentFailedNotice("report.md", "en")).toContain("could not attach");
    expect(attachmentFailedNotice("report.md", "es")).toContain("No he podido");
    expect(attachmentFailedNotice("report.md", "fr")).toContain("réussi");
    expect(attachmentFailedNotice("report.md", "it")).toContain("Non sono riuscita");
  });

  it("falls back to Italian when the language was never determined", () => {
    for (const notice of ALL) {
      expect(notice("report.md", "unknown")).toBe(notice("report.md", "it"));
    }
  });

  it("names the file in every language and never an emoji", () => {
    for (const notice of ALL) {
      for (const lang of ["it", "en", "es", "fr", "unknown"] as const) {
        const text = notice("preventivo.pdf", lang);
        expect(text).toContain("preventivo.pdf");
        // The house style leaves emoji to the user; two notices shipped with one.
        expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
        // A notice is a sentence, not a parenthetical fragment.
        expect(text.trim().startsWith("(")).toBe(false);
      }
    }
  });

  it("separates the retryable failure from the one retrying can never fix", () => {
    const retryable = attachmentFailedNotice("a.md", "en").toLowerCase();
    const permanent = attachmentsUnsupportedNotice("a.md", "en").toLowerCase();
    expect(retryable).toContain("try again");
    expect(permanent).toContain("cannot");
    expect(permanent).not.toContain("try again");
  });

  it("shows the file name and never the workspace path", () => {
    expect(displayFileName("bozze/2026/preventivo-acme.md")).toBe("preventivo-acme.md");
    expect(displayFileName("report.md")).toBe("report.md");
    expect(displayFileName("")).toBe("");
    expect(attachmentUnreadableNotice(displayFileName("a/b/c.md"), "it")).not.toContain("a/b");
  });
});

describe("the language the platform writes in", () => {
  it("is the one detected on the pair's turns", () => {
    const t = new TurnMetaTracker();
    t.prefix("agent-1", "u1", "hello, can you help me with the document please");
    expect(t.languageFor("agent-1", "u1")).toBe("en");
  });

  it("is unknown for a pair nobody has spoken to", () => {
    expect(new TurnMetaTracker().languageFor("agent-1", "nobody")).toBe("unknown");
  });

  it("survives a short turn the detector cannot read", () => {
    const t = new TurnMetaTracker();
    t.prefix("agent-1", "u1", "hello, can you help me with the document please");
    t.prefix("agent-1", "u1", "ok");
    // A bare "ok" used to be indistinguishable from a conversation that had
    // never been read, which would switch the platform back to Italian.
    expect(t.languageFor("agent-1", "u1")).toBe("en");
  });

  it("is kept per pair, not per process", async () => {
    const t = new TurnMetaTracker();
    await t.prefixWithContext("agent-1", "u1", "hola, puedes ayudarme con este documento");
    await t.prefixWithContext("agent-1", "u2", "bonjour, peux-tu m'aider avec ce document");
    expect(t.languageFor("agent-1", "u1")).toBe("es");
    expect(t.languageFor("agent-1", "u2")).toBe("fr");
  });
});

describe("the notices that used to be Italian-only", () => {
  it("localises the oversize-upload notice", () => {
    expect(oversizeUploadNotice(["a.pdf"], 25, "en")).toContain("over the 25 MB limit");
    expect(oversizeUploadNotice(["a.pdf"], 25, "fr")).toContain("25 Mo");
    expect(oversizeUploadNotice(["a.pdf"], 25, "unknown")).toBe(oversizeUploadNotice(["a.pdf"], 25, "it"));
  });

  it("says one file or several, and names them all", () => {
    const many = oversizeUploadNotice(["a.pdf", "b.png"], 8, "en");
    expect(many).toContain("«a.pdf»");
    expect(many).toContain("«b.png»");
    expect(many).toContain("are over");
    expect(oversizeUploadNotice(["a.pdf"], 8, "en")).toContain("is over");
  });

  it("gives the delivery failure one language, not two joined by a slash", () => {
    for (const lang of ["it", "en", "es", "fr"] as const) {
      const text = deliveryFailureNotice(lang);
      expect(text).not.toContain(" / ");
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    }
    expect(deliveryFailureNotice("en")).toContain("did not get through");
  });
});

describe("one register across every platform notice", () => {
  it("carries no emoji in any language", () => {
    const everything = [
      ...(["it", "en", "es", "fr", "unknown"] as const).flatMap((l) => [
        attachmentFailedNotice("f", l),
        attachmentUnreadableNotice("f", l),
        attachmentsUnsupportedNotice("f", l),
        deliveryFailureNotice(l),
        oversizeUploadNotice(["f"], 10, l),
        pickErrorMessage(l === "it" ? "ciao come stai grazie" : "hello how are you please"),
        pickEmptyMessage(l === "it" ? "ciao come stai grazie" : "hello how are you please"),
        pickNoCreditsMessage(l === "it" ? "ciao come stai grazie" : "hello how are you please"),
        pickRefusalMessage(l === "it" ? "ciao come stai grazie" : "hello how are you please"),
      ]),
    ];
    for (const text of everything) {
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

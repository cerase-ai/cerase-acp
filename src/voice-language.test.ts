import { describe, expect, it } from "vitest";
import { detectLanguage, TurnMetaTracker } from "./turn-meta.js";

// A turn with no words of the person's keeps the conversation's language.
//
// On guidance on 10 October two Italian voice messages reached the assistant as
// `[Uploaded files: uploads/…/voice-message.ogg]` and nothing else, and the
// bridge tagged both `lang=en`: «files» is one of the English words the
// detection counts. The assistant's next lines came out in Chinese twice, each
// after an English tool result. Every name here is invented.

const VOICE = "[Uploaded files: uploads/2026-10-10/voice-message.ogg]";
const T0 = 1_791_600_000_000;

describe("the language of a turn with no words of the person's", () => {
  it("is not read from the block of uploaded files", () => {
    expect(detectLanguage(VOICE)).toBe("unknown");
    expect(detectLanguage(`[Uploaded files: uploads/a/report-files-final.pdf, uploads/a/the-document.docx]`)).toBe(
      "unknown",
    );
  });

  it("is the conversation's own after Italian turns: a voice message reads lang=it", () => {
    const t = new TurnMetaTracker();
    t.prefix("agent-3", "seat:p", "ciao, mi prepari la risposta a Clelia per giovedì?", T0);
    const voice = t.prefix("agent-3", "seat:p", VOICE, T0 + 60_000);

    expect(voice).toContain("lang=it");
  });

  it("is the conversation's own for an attachment with a short caption", () => {
    const t = new TurnMetaTracker();
    t.prefix("agent-3", "seat:p", "buongiorno, ti giro il listino della concorrenza", T0);
    const caption = t.prefix("agent-3", "seat:p", `${VOICE}\n\necco`, T0 + 60_000);

    expect(caption).toContain("lang=it");
  });

  it("is still read from the words the person wrote beside the files", () => {
    const t = new TurnMetaTracker();
    t.prefix("agent-3", "seat:p", "ciao, come stai?", T0);
    const english = t.prefix(
      "agent-3",
      "seat:p",
      `${VOICE}\n\nplease summarise the document and the files`,
      T0 + 60_000,
    );

    expect(english).toContain("lang=en");
  });

  it("is the organisation's when the conversation has none yet, as after a bridge restart", async () => {
    const t = new TurnMetaTracker();
    const first = await t.prefixWithContext("agent-3", "seat:p", VOICE, { now: T0, fallbackLang: "it" });

    expect(first).toContain("lang=it");
  });
});

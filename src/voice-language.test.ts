import { describe, expect, it } from "vitest";
import { specTest } from "./test-support/spec-rows.js";
import { detectLanguage, type SupportedLang, TurnMetaTracker } from "./turn-meta.js";

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
  specTest("ACP-TURN-024", "is not read from the block of uploaded files", (row) => {
    const voice = row.quoted("when")[0]!;
    const detected = detectLanguage(voice);
    expect(detected).toBe("unknown");
    expect(detectLanguage(`[Uploaded files: uploads/a/report-files-final.pdf, uploads/a/the-document.docx]`)).toBe(
      "unknown",
    );

    const notWords = detected === "unknown";
    const observed = `the block of uploaded files is ${notWords ? "not" : ""} read as the person's words and the language is "${detected}"`;
    expect(observed).toBe(row.expect);
  });

  specTest("ACP-TURN-025", "is the conversation's own after Italian turns: a voice message reads lang=it", (row) => {
    const t = new TurnMetaTracker();
    t.prefix("agent-3", "seat:p", "ciao, mi prepari la risposta a Clelia per giovedì?", T0);
    const voice = t.prefix("agent-3", "seat:p", VOICE, T0 + 60_000);

    expect(voice).toContain("lang=it");

    const lang = /lang=([a-z]+)/i.exec(voice)?.[1] ?? "";
    const observed = `the turn is tagged "lang=${lang}", the conversation's previous language`;
    expect(observed).toBe(row.expect);
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
    // The first English sentence could be pasted, so it is `unknown`; the
    // second one in a row moves the conversation.
    const english = t.prefix(
      "agent-3",
      "seat:p",
      `${VOICE}\n\nplease summarise the document and the files`,
      T0 + 60_000,
    );

    expect(english).toContain("lang=unknown");
    expect(t.prefix("agent-3", "seat:p", "thanks, that is everything for now", T0 + 120_000)).toContain("lang=en");
  });

  specTest(
    "ACP-TURN-026",
    "is the organisation's when the conversation has none yet, as after a bridge restart",
    async (row) => {
      const fallbackLang = row.quoted("when")[0] as SupportedLang;
      const t = new TurnMetaTracker();
      const first = await t.prefixWithContext("agent-3", "seat:p", VOICE, { now: T0, fallbackLang });

      expect(first).toContain("lang=it");

      const lang = /lang=([a-z]+)/i.exec(first)?.[1] ?? "";
      const observed = `the turn is tagged "lang=${lang}", the organisation's`;
      expect(observed).toBe(row.expect);
    },
  );
});

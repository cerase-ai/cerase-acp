import { describe, expect, it } from "vitest";
import { specTest } from "./test-support/spec-rows.js";
import { detectLanguage, TurnMetaTracker } from "./turn-meta.js";

// «Sì, ho cambiato idea: preparala tu.» reached an assistant stamped `lang=fr`:
// the detector counted stopwords, «tu» is in the French list, and nothing in
// the Italian one matched. A short message is tagged in its own language when
// its words say so, and keeps the conversation's language when they do not.

const SHORT: Record<"it" | "en" | "es" | "fr", string[]> = {
  it: [
    "Sì, ho cambiato idea: preparala tu.",
    "Va bene, mandala tu.",
    "Ok, la mando io domani.",
    "Sì, è giusto così.",
    "No, aspetta un attimo.",
  ],
  en: ["Yes, go ahead and send it.", "Sure, you can do it now.", "No, wait for me.", "Thanks, that is fine."],
  es: ["Sí, prepáralo tú.", "Vale, la envío yo.", "No, espera un momento.", "Gracias, está bien así."],
  fr: ["Oui, envoie-la maintenant.", "D'accord, je m'en occupe.", "Non, attends un peu.", "Merci, c'est parfait."],
};

describe("a short message", () => {
  for (const [lang, messages] of Object.entries(SHORT)) {
    for (const message of messages) {
      it(`«${message}» is not tagged as another language than ${lang}`, () => {
        const detected = detectLanguage(message);
        expect(["unknown", lang]).toContain(detected);
      });
    }
  }

  specTest("ACP-TURN-029", "«Sì, ho cambiato idea: preparala tu.» is Italian", (row) => {
    const message = row.quoted("when")[0]!;
    const detected = detectLanguage(message);
    expect(detected).toBe("it");

    const observed = `it is tagged ${detected === "it" ? "Italian" : detected} and ${detected !== "fr" ? "not French" : "French"}`;
    expect(observed).toBe(row.expect);
  });

  specTest("ACP-TURN-030", "keeps the conversation's language when its words do not decide another", (row) => {
    const [first, second] = row.quoted("when");
    const tracker = new TurnMetaTracker();
    tracker.prefix("a", "u", "ciao, mi prepari la bozza della risposta per il cliente?", 0);
    const messages = [first!, second!, "Perfetto.", "No, aspetta."];
    const langs: string[] = [];
    for (const message of messages) {
      const block = tracker.prefix("a", "u", message, 1000);
      expect(block).toContain("lang=it");
      langs.push(/lang=([a-z]+)/i.exec(block)?.[1] ?? "");
    }

    const allItalian = langs.every((lang) => lang === "it");
    const observed = `each keeps ${allItalian ? '"lang=it"' : "another language"}, the conversation's language`;
    expect(observed).toBe(row.expect);
  });

  specTest(
    "ACP-TURN-031",
    "follows the person into another language when the words are plainly that language",
    (row) => {
      const tracker = new TurnMetaTracker();
      tracker.prefix("a", "u", "ciao, mi prepari la bozza della risposta per il cliente?", 0);
      // The first English sentence could be pasted, so it is `unknown`; the
      // second one in a row moves the conversation.
      const first = tracker.prefix("a", "u", "can you write it in English for the client, please?", 1000);
      const second = tracker.prefix("a", "u", "thanks, that is everything for now", 2000);
      expect(first).toContain("lang=unknown");
      expect(second).toContain("lang=en");

      const firstLang = /lang=([a-z]+)/i.exec(first)?.[1] ?? "";
      const secondLang = /lang=([a-z]+)/i.exec(second)?.[1] ?? "";
      const observed = `the first is tagged "lang=${firstLang}" and the second "lang=${secondLang}"`;
      expect(observed).toBe(row.expect);
    },
  );
});

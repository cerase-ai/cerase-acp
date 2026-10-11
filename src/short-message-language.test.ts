import { describe, expect, it } from "vitest";
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

  it("«Sì, ho cambiato idea: preparala tu.» is Italian", () => {
    expect(detectLanguage("Sì, ho cambiato idea: preparala tu.")).toBe("it");
  });

  it("keeps the conversation's language when its words do not decide another", () => {
    const tracker = new TurnMetaTracker();
    tracker.prefix("a", "u", "ciao, mi prepari la bozza della risposta per il cliente?", 0);
    for (const message of ["Ok, la mando io domani.", "Va bene, mandala tu.", "Perfetto.", "No, aspetta."]) {
      expect(tracker.prefix("a", "u", message, 1000)).toContain("lang=it");
    }
  });

  it("follows the person into another language when the words are plainly that language", () => {
    const tracker = new TurnMetaTracker();
    tracker.prefix("a", "u", "ciao, mi prepari la bozza della risposta per il cliente?", 0);
    expect(tracker.prefix("a", "u", "can you write it in English for the client, please?", 1000)).toContain("lang=en");
  });
});

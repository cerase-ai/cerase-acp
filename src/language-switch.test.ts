import { describe, expect, it } from "vitest";
import { TurnMetaTracker } from "./turn-meta.js";

// A message whose words are in another language than the conversation's is
// tagged `lang=unknown` the first time, and only the second one in a row moves
// the conversation.
//
// On a tenant on 19 October a person pasted an English Meet invitation, alone,
// into an Italian conversation; the bridge tagged that turn `lang=en` and the
// reply came in English, and the tag stayed `en` on the Italian messages after
// it. Measured on the bench on 23 October (family `f33 lingua del turno` in
// cerase-core's `tests/model-eval`, 20 sessions each): the pasted invitation
// tagged `en` got an English reply 6 times in 20, tagged `it` or `unknown` 0 in
// 20; a person really switching to English got English replies whether the
// first English message was tagged `it`, `unknown` or `en` (20/20, 19/19,
// 20/20). A message the person did not write in their language cannot be told
// from one they did, so the first message in another language says `unknown`
// and lets the model read the words, and the second one in a row moves the
// conversation. Every name here is invented.

const AGENT = "agent-12";
const USER = "seat:q";
const T0 = 1_791_600_000_000;

const INVITATION =
  "To join the video meeting, click this link: https://meet.google.com/abc-defg-hij\n" +
  "To join by phone instead, dial (IT) +39 02 5550 1234 and enter this PIN: 555 012 345#\n" +
  "More numbers: https://t.meet/abc-defg-hij";

const LONDON = "What time does the call with the London office start tomorrow, and who is joining from their side?";
const FOLLOW_UP = "Thanks. Can you also tell me if there is anything I need to prepare for it?";

describe("a message whose words are in another language than the conversation's", () => {
  it("is tagged unknown the first time, and the Italian conversation stays Italian", () => {
    const t = new TurnMetaTracker();
    t.prefix(AGENT, USER, "ciao, mi prepari la bozza della risposta per il cliente?", T0);

    const pasted = t.prefix(AGENT, USER, INVITATION, T0 + 60_000);
    expect(pasted).toContain("lang=unknown");

    const afterOne = t.prefix(AGENT, USER, "ma stai entrando con playwright o col bot corretto?", T0 + 120_000);
    expect(afterOne).toContain("lang=it");

    const afterTwo = t.prefix(AGENT, USER, "mettile tutte come lette", T0 + 180_000);
    expect(afterTwo).toContain("lang=it");
  });

  it("does not change the language the bridge writes its own notices in", () => {
    const t = new TurnMetaTracker();
    t.prefix(AGENT, USER, "ciao, mi prepari la bozza della risposta per il cliente?", T0);
    t.prefix(AGENT, USER, INVITATION, T0 + 60_000);

    expect(t.languageFor(AGENT, USER)).toBe("it");
  });

  it("moves the conversation only when the second message in a row points to the same language", () => {
    const t = new TurnMetaTracker();
    t.prefix(AGENT, USER, "ciao, mi prepari la bozza della risposta per il cliente?", T0);

    const first = t.prefix(AGENT, USER, LONDON, T0 + 60_000);
    expect(first).toContain("lang=unknown");

    const second = t.prefix(AGENT, USER, FOLLOW_UP, T0 + 120_000);
    expect(second).toContain("lang=en");

    expect(t.languageFor(AGENT, USER)).toBe("en");
  });

  it("does not count a message in another language between two in the conversation's", () => {
    const t = new TurnMetaTracker();
    t.prefix(AGENT, USER, "ciao, mi prepari la bozza della risposta per il cliente?", T0);

    const firstEnglish = t.prefix(
      AGENT,
      USER,
      "Could you send me the notes from yesterday's meeting, please?",
      T0 + 60_000,
    );
    expect(firstEnglish).toContain("lang=unknown");

    const italianAgain = t.prefix(AGENT, USER, "va bene, allora la mando io domani", T0 + 120_000);
    expect(italianAgain).toContain("lang=it");

    const englishAgain = t.prefix(
      AGENT,
      USER,
      "Could you send me the notes from yesterday's meeting, please?",
      T0 + 180_000,
    );
    expect(englishAgain).toContain("lang=unknown");
  });

  it("still takes its own words' language on the first message of a conversation", () => {
    const t = new TurnMetaTracker();

    const first = t.prefix(AGENT, USER, LONDON, T0);
    expect(first).toContain("lang=en");
  });
});

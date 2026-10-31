import { describe, expect, it } from "vitest";
import { detectLanguage, formatGap, makeTurnMetaBlock, personWords, TURN_RULE, TurnMetaTracker } from "./turn-meta.js";

describe("formatGap", () => {
  it("returns 'first' when prevAt is undefined", () => {
    expect(formatGap(undefined, Date.now())).toBe("first");
  });

  it("returns minutes for sub-hour gaps", () => {
    const now = Date.now();
    expect(formatGap(now - 30 * 1000, now)).toBe("30s");
    expect(formatGap(now - 5 * 60 * 1000, now)).toBe("5m");
    expect(formatGap(now - 59 * 60 * 1000, now)).toBe("59m");
  });

  it("returns hours for sub-day gaps", () => {
    const now = Date.now();
    expect(formatGap(now - 2 * 60 * 60 * 1000, now)).toBe("2h");
    expect(formatGap(now - 23 * 60 * 60 * 1000, now)).toBe("23h");
  });

  it("returns days for >= 1 day gaps", () => {
    const now = Date.now();
    expect(formatGap(now - 25 * 60 * 60 * 1000, now)).toBe("1d");
    expect(formatGap(now - 7 * 24 * 60 * 60 * 1000, now)).toBe("7d");
  });
});

describe("detectLanguage", () => {
  it("detects Italian on common stopwords", () => {
    expect(detectLanguage("ciao, mi puoi aiutare a riassumere il documento?")).toBe("it");
    expect(detectLanguage("non ho capito bene la domanda")).toBe("it");
  });

  it("detects English on common stopwords", () => {
    expect(detectLanguage("hello, can you help me summarise the document?")).toBe("en");
    expect(detectLanguage("what is the difference between these two files")).toBe("en");
  });

  it("detects Spanish on common stopwords", () => {
    expect(detectLanguage("hola, ¿puedes ayudarme con este documento?")).toBe("es");
  });

  it("detects French on common stopwords", () => {
    expect(detectLanguage("bonjour, peux-tu m'aider avec ce document?")).toBe("fr");
  });

  it("returns 'unknown' for ambiguous or empty input", () => {
    expect(detectLanguage("")).toBe("unknown");
    expect(detectLanguage("123 456")).toBe("unknown");
    expect(detectLanguage("xy zw qr")).toBe("unknown");
  });
});

describe("a transcribed voice message", () => {
  const TRANSCRIPT = "Ciao Matilde, mi prepari la bozza dell'offerta?";
  const VOICE = `[Voice message, transcribed from uploads/1-0/voice.ogg: «${TRANSCRIPT}»]`;

  it("keeps the transcript's words and drops the marker words and the path", () => {
    const words = personWords(VOICE);

    expect(words).toContain(TRANSCRIPT);
    expect(words).not.toContain("Voice message");
    expect(words).not.toContain("transcribed from");
    expect(words).not.toContain("uploads/1-0/voice.ogg");
  });

  it("tags an Italian-only voice message as Italian", () => {
    expect(detectLanguage(VOICE)).toBe("it");
  });

  it("moves an Italian conversation to English by the rule a typed message follows", () => {
    const t = new TurnMetaTracker();
    const t0 = 1_700_000_000_000;
    const english = "[Voice message, transcribed from uploads/1-0/voice.ogg: «Thanks, that is everything for now»]";

    expect(t.prefix("doc-qa", "user-A", "ciao", t0)).toContain("lang=it");
    // One strong turn in another language could be pasted text, so it is
    // tagged unknown; the next one in a row moves the conversation.
    expect(t.prefix("doc-qa", "user-A", english, t0 + 60 * 1000)).toContain("lang=unknown");
    expect(t.prefix("doc-qa", "user-A", english, t0 + 120 * 1000)).toContain("lang=en");
  });
});

describe("makeTurnMetaBlock", () => {
  it("states the rule the assistant must follow before its first tool call", () => {
    expect(TURN_RULE).toBe("before your first tool call, say in one line what you understood and will do");
  });

  it("formats the [turn_meta: ...] prefix with gap + lang", () => {
    const block = makeTurnMetaBlock({ gap: "first", lang: "it" });
    expect(block).toBe(
      "[turn_meta: gap=first, lang=it; before your first tool call, say in one line what you understood and will do]\n\n",
    );
  });

  it("puts the written-during-previous-work age after the clock", () => {
    const block = makeTurnMetaBlock({
      gap: "2m",
      lang: "it",
      now: "2026-10-22 09:12 (Europe/Rome)",
      writtenAgo: "1m",
    });
    expect(block).toBe(
      "[turn_meta: gap=2m, lang=it, now=2026-10-22 09:12 (Europe/Rome), written_during_previous_work=1m ago; before your first tool call, say in one line what you understood and will do]\n\n",
    );
  });

  it("puts the written-during-previous-work age after lang when there is no clock", () => {
    const block = makeTurnMetaBlock({ gap: "2m", lang: "it", writtenAgo: "1m" });
    expect(block).toBe(
      "[turn_meta: gap=2m, lang=it, written_during_previous_work=1m ago; before your first tool call, say in one line what you understood and will do]\n\n",
    );
  });

  it("leaves the block unchanged without the written-during-previous-work age", () => {
    const block = makeTurnMetaBlock({ gap: "2m", lang: "it", now: "2026-10-22 09:12 (Europe/Rome)" });
    expect(block).toBe(
      "[turn_meta: gap=2m, lang=it, now=2026-10-22 09:12 (Europe/Rome); before your first tool call, say in one line what you understood and will do]\n\n",
    );
  });

  it("ends every block with the rule and has exactly one closing bracket", () => {
    const variants = [
      makeTurnMetaBlock({ gap: "first", lang: "it" }),
      makeTurnMetaBlock({ gap: "2m", lang: "it", now: "2026-10-22 09:12 (Europe/Rome)" }),
      makeTurnMetaBlock({ gap: "2m", lang: "it", writtenAgo: "1m" }),
      makeTurnMetaBlock({
        gap: "2m",
        lang: "it",
        now: "2026-10-22 09:12 (Europe/Rome)",
        writtenAgo: "1m",
      }),
    ];

    for (const block of variants) {
      expect(block.match(/]/g)).toHaveLength(1);
      expect(block.endsWith(`; ${TURN_RULE}]\n\n`)).toBe(true);
    }
  });

  it("is taken out whole by the regex the console and the privacy filter use", () => {
    const block = makeTurnMetaBlock({ gap: "first", lang: "it" });

    expect(`${block}ciao`.replace(/^\s*\[turn_meta:[^\]]*\]\s*\n*/, "")).toBe("ciao");
  });

  it("still lets a later reader take the language from the block", () => {
    const block = makeTurnMetaBlock({ gap: "first", lang: "it" });
    const match = block.match(/\[turn_meta:[^\]]*\blang=([a-z]{2})\b/i);

    expect(match?.[1]).toBe("it");
  });
});

describe("TurnMetaTracker", () => {
  it("first turn → gap=first; subsequent → measured gap", () => {
    const t = new TurnMetaTracker();
    const t0 = 1_700_000_000_000;
    const first = t.prefix("doc-qa", "user-A", "ciao", t0);
    expect(first).toBe(
      "[turn_meta: gap=first, lang=it; before your first tool call, say in one line what you understood and will do]\n\n",
    );
    // One English word does not move an Italian conversation; a sentence in
    // another language is `unknown` the first time — it could be pasted — and
    // the next one in a row moves the conversation.
    const second = t.prefix("doc-qa", "user-A", "hello", t0 + 5 * 60 * 1000);
    expect(second).toBe(
      "[turn_meta: gap=5m, lang=it; before your first tool call, say in one line what you understood and will do]\n\n",
    );
    const third = t.prefix("doc-qa", "user-A", "hello, can you help me with this?", t0 + 6 * 60 * 1000);
    expect(third).toBe(
      "[turn_meta: gap=1m, lang=unknown; before your first tool call, say in one line what you understood and will do]\n\n",
    );
    const fourth = t.prefix("doc-qa", "user-A", "thanks, that is everything for now", t0 + 7 * 60 * 1000);
    expect(fourth).toBe(
      "[turn_meta: gap=1m, lang=en; before your first tool call, say in one line what you understood and will do]\n\n",
    );
  });

  it("tracks per (agent, user) — distinct keys are independent", () => {
    const t = new TurnMetaTracker();
    const t0 = 1_700_000_000_000;
    t.prefix("doc-qa", "user-A", "ciao", t0);
    // user-B's first turn must still report gap=first, not the 1m gap
    // since user-A's turn.
    const userB = t.prefix("doc-qa", "user-B", "hello", t0 + 60 * 1000);
    expect(userB).toBe(
      "[turn_meta: gap=first, lang=en; before your first tool call, say in one line what you understood and will do]\n\n",
    );
  });

  it("marks a turn written during the previous work, its age formatted like the gap", async () => {
    const t = new TurnMetaTracker();
    const now = 1_700_000_000_000;
    const block = await t.prefixWithContext("doc-qa", "user-A", "ciao", {
      now,
      writtenAt: now - 90 * 1000,
    });
    expect(block).toBe(
      "[turn_meta: gap=first, lang=it, written_during_previous_work=1m ago; before your first tool call, say in one line what you understood and will do]\n\n",
    );
  });
});

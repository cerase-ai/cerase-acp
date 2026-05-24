import { describe, it, expect } from "vitest";
import { TurnMetaTracker, detectLanguage, formatGap, makeTurnMetaBlock } from "./turn-meta.js";

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

describe("makeTurnMetaBlock", () => {
  it("formats the [turn_meta: ...] prefix with gap + lang", () => {
    const block = makeTurnMetaBlock({ gap: "first", lang: "it" });
    expect(block).toBe("[turn_meta: gap=first, lang=it]\n\n");
  });
});

describe("TurnMetaTracker", () => {
  it("first turn → gap=first; subsequent → measured gap", () => {
    const t = new TurnMetaTracker();
    const t0 = 1_700_000_000_000;
    const first = t.prefix("doc-qa", "user-A", "ciao", t0);
    expect(first).toBe("[turn_meta: gap=first, lang=it]\n\n");
    const second = t.prefix("doc-qa", "user-A", "hello", t0 + 5 * 60 * 1000);
    expect(second).toBe("[turn_meta: gap=5m, lang=en]\n\n");
  });

  it("tracks per (agent, user) — distinct keys are independent", () => {
    const t = new TurnMetaTracker();
    const t0 = 1_700_000_000_000;
    t.prefix("doc-qa", "user-A", "ciao", t0);
    // user-B's first turn must still report gap=first, not the 1m gap
    // since user-A's turn.
    const userB = t.prefix("doc-qa", "user-B", "hello", t0 + 60 * 1000);
    expect(userB).toBe("[turn_meta: gap=first, lang=en]\n\n");
  });
});

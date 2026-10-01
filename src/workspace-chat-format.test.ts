// Google Chat does not render Markdown: a bold word arrives between four literal
// asterisks. It has its own markup — *bold*, _italic_, ~strike~, <url|text>
// — and the assistant writes Markdown, so the reply is translated on the way out.

import { describe, expect, it } from "vitest";
import { CHAT_MESSAGE_MAX_BYTES, splitForGoogleChat, toChatText } from "./workspace-chat-format.js";

describe("toChatText", () => {
  it("turns Markdown bold into Chat bold", () => {
    expect(toChatText("the note was **not** created")).toBe("the note was *not* created");
    expect(toChatText("__done__")).toBe("*done*");
  });

  it("turns Markdown italics into Chat italics, without touching bold", () => {
    expect(toChatText("an *important* point and **a bold one**")).toBe("an _important_ point and *a bold one*");
  });

  it("turns strikethrough and links into Chat's forms", () => {
    expect(toChatText("~~old~~ price")).toBe("~old~ price");
    expect(toChatText("see [the record](https://app.example.com/r/1)")).toBe(
      "see <https://app.example.com/r/1|the record>",
    );
  });

  it("turns headings into a bold line and bullets into a dot", () => {
    expect(toChatText("## Contacts\n- Brian\n* Maria\n  - nested")).toBe("*Contacts*\n• Brian\n• Maria\n  • nested");
  });

  it("keeps numbered lists as they are", () => {
    expect(toChatText("1. first\n2. second")).toBe("1. first\n2. second");
  });

  it("leaves code alone, inline and fenced", () => {
    const fenced = "```\nx = **y**\n```";
    expect(toChatText(fenced)).toBe(fenced);
    expect(toChatText("run `a **b**` now, **then** stop")).toBe("run `a **b**` now, *then* stop");
  });

  it("does not read a multiplication or a lone asterisk as markup", () => {
    expect(toChatText("3 * 4 = 12")).toBe("3 * 4 = 12");
    expect(toChatText("note*")).toBe("note*");
  });

  it("does not touch underscores inside words", () => {
    expect(toChatText("call snake_case_name")).toBe("call snake_case_name");
  });
});

// One message holds at most 32,000 bytes on Google Chat, text and cards
// together. An answer is one message up to there, and two past it.
describe("splitForGoogleChat", () => {
  const bytes = (s: string) => Buffer.byteLength(s, "utf8");
  const paragraph = (i: number) =>
    `Paragrafo ${i}: la consegna è prevista per venerdì, perché il fornitore ha già confermato la disponibilità della merce e il trasporto.`;
  const paragraphs = (n: number) => Array.from({ length: n }, (_, i) => paragraph(i + 1)).join("\n\n");

  it("leaves an answer of 2,000 characters whole", () => {
    const answer = paragraphs(16);
    expect(answer.length).toBeGreaterThan(2000);
    expect(splitForGoogleChat(answer)).toEqual([answer]);
  });

  it("leaves whole an answer of 29,000 bytes, which Discord would cut in fifteen", () => {
    const answer = paragraphs(215);
    expect(bytes(answer)).toBeGreaterThan(29_000);
    expect(bytes(answer)).toBeLessThan(30_000);
    expect(splitForGoogleChat(answer)).toEqual([answer]);
  });

  it("cuts an answer larger than one message in two, at the end of a paragraph, each part within the limit", () => {
    const answer = paragraphs(300);
    expect(bytes(answer)).toBeGreaterThan(CHAT_MESSAGE_MAX_BYTES);
    const parts = splitForGoogleChat(answer);
    expect(parts).toHaveLength(2);
    for (const part of parts) expect(bytes(toChatText(part))).toBeLessThanOrEqual(CHAT_MESSAGE_MAX_BYTES);
    expect(parts[0]).toMatch(
      /venerdì, perché il fornitore ha già confermato la disponibilità della merce e il trasporto\. ⏎$/,
    );
    expect(parts[1]).toMatch(/^Paragrafo \d+: /);
    expect(`${parts[0]!.replace(/ ⏎$/, "")}\n\n${parts[1]}`).toBe(answer);
  });

  it("measures the text as Chat receives it, where a bullet takes more bytes than Markdown's dash", () => {
    // 6,000 bullets of "- x": 24,000 bytes as written, 36,000 once each dash is a •.
    const answer = Array.from({ length: 6000 }, () => "- x").join("\n");
    expect(bytes(answer)).toBeLessThan(CHAT_MESSAGE_MAX_BYTES);
    const parts = splitForGoogleChat(answer);
    expect(parts).toHaveLength(2);
    for (const part of parts) expect(bytes(toChatText(part))).toBeLessThanOrEqual(CHAT_MESSAGE_MAX_BYTES);
  });

  it("never cuts a character outside the basic plane in half", () => {
    const answer = "🙂".repeat(9000);
    const parts = splitForGoogleChat(answer);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("").replace(/ ⏎/g, "")).toBe(answer);
    for (const part of parts) expect(part).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("answers no message for no text", () => {
    expect(splitForGoogleChat("")).toEqual([]);
  });
});

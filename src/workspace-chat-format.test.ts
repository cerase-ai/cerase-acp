// Google Chat does not render Markdown: a bold word arrives between four literal
// asterisks. It has its own markup — *bold*, _italic_, ~strike~, <url|text>
// — and the assistant writes Markdown, so the reply is translated on the way out.

import { describe, expect, it } from "vitest";
import { toChatText } from "./workspace-chat-format.js";

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

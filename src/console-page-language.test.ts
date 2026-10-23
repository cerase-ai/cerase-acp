import { describe, expect, it } from "vitest";
import { detectLanguage, TurnMetaTracker } from "./turn-meta.js";

// The console's side panel names the page in the first line of the message.
//
// Found on 23 October: the side panel sends `[console_page: «<title>», <path>]`,
// a blank line, then what the person wrote. The control-plane strips that line
// before showing the person's bubble; the bridge does not, so the page title's
// words were counted as the person's. An administrator writing «Why is this
// skill off?» from the page «Il tuo assistente e le sue competenze» was read
// from «il» and «e» against «is» and «this» -- a tie, `lang=unknown` -- and
// then fell back to the organisation's Italian. Every name here is invented.

const ON_AGENT_PAGE =
  "[console_page: «Il tuo assistente e le sue competenze», /admin/agents/3]\n\nWhy is this skill off?";
const T0 = 1_791_600_000_000;

describe("the language of a turn whose first line names the console page", () => {
  it("is read from the person's words, not from the Italian page title", () => {
    expect(detectLanguage(ON_AGENT_PAGE)).toBe("en");
  });

  it("does not fall back to the organisation's language when the person wrote English", async () => {
    const meta = await new TurnMetaTracker().prefixWithContext("agent-1", "seat:a", ON_AGENT_PAGE, {
      now: T0,
      fallbackLang: "it",
    });

    expect(meta).toContain("lang=en");
  });

  it("keeps an Italian message from a page with an English title in Italian", () => {
    expect(
      detectLanguage("[console_page: «Connectors», /admin/connectors]\n\nperché questo connettore è spento?"),
    ).toBe("it");
  });

  it("is unknown when the message is only the page line", () => {
    expect(detectLanguage("[console_page: «Il tuo assistente e le sue competenze», /admin/agents/3]")).toBe("unknown");
  });

  it("still counts a console_page line the person wrote themselves", () => {
    expect(detectLanguage("guarda questo, è quello che vedo io:\n[console_page: «Overview», /admin]")).toBe("it");
  });
});

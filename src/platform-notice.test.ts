import { describe, expect, it } from "vitest";
import {
  discordNoticeMessages,
  googleChatNoticeMessage,
  noticeText,
  PLATFORM_COLOUR,
  PLATFORM_SENDER,
  type PlatformNotice,
  parsePlatformNotice,
  SLACK_NOTICE_ACTION_ID,
  slackNoticeMessage,
  splitAtLines,
  telegramNoticeMessages,
} from "./platform-notice.js";

// What a platform notice looks like on each channel. The adapters hand these
// payloads to their SDKs unchanged, and their own tests check that they do.

const APPROVAL: PlatformNotice = {
  title: "Richiesta di approvazione",
  body: "«Matilde» chiede la tua approvazione per: invia una mail\n- A: anna@example.com\nLa richiesta scade oggi alle 18:00.",
  link: { url: "https://acme.cerase.ai/a/Xy7Kq2", label: "Approva o rifiuta" },
};

describe("parsePlatformNotice", () => {
  it("reads a title, a body and a link", () => {
    expect(parsePlatformNotice(APPROVAL)).toEqual(APPROVAL);
  });

  it("reads a notice without a link", () => {
    expect(parsePlatformNotice({ title: "Trascrizione non riuscita", body: "x" })).toEqual({
      title: "Trascrizione non riuscita",
      body: "x",
    });
    expect(parsePlatformNotice({ title: "T", body: "x", link: null })).toEqual({ title: "T", body: "x" });
  });

  it("refuses what would draw an empty box or a button that opens nothing", () => {
    expect(parsePlatformNotice(undefined)).toBeUndefined();
    expect(parsePlatformNotice("testo")).toBeUndefined();
    expect(parsePlatformNotice({ title: " ", body: "x" })).toBeUndefined();
    expect(parsePlatformNotice({ title: "T" })).toBeUndefined();
    expect(parsePlatformNotice({ title: "T", body: "x", link: { url: "javascript:alert(1)", label: "L" } })).toBe(
      undefined,
    );
    expect(parsePlatformNotice({ title: "T", body: "x", link: { url: "https://x.example", label: "" } })).toBe(
      undefined,
    );
    expect(parsePlatformNotice({ title: "T", body: "x", link: "https://x.example" })).toBeUndefined();
  });
});

describe("noticeText, for a channel with no box", () => {
  it("names the platform, says the notice and spells the address out", () => {
    expect(noticeText(APPROVAL)).toBe(
      [
        "Cerase · Richiesta di approvazione",
        "«Matilde» chiede la tua approvazione per: invia una mail",
        "- A: anna@example.com",
        "La richiesta scade oggi alle 18:00.",
        "Approva o rifiuta: https://acme.cerase.ai/a/Xy7Kq2",
      ].join("\n"),
    );
  });
});

describe("splitAtLines", () => {
  it("keeps every character, cutting at line ends where it can", () => {
    const text = ["aaaa", "bbbb", "cccc"].join("\n");
    expect(splitAtLines(text, 9)).toEqual(["aaaa\nbbbb", "cccc"]);
    expect(splitAtLines("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(splitAtLines("", 4)).toEqual([""]);
  });
});

describe("Discord: an embed signed by the platform, with a link button", () => {
  it("draws the notice as one embed in the console's colour and the link as a button", () => {
    const [message, ...more] = discordNoticeMessages(APPROVAL);
    expect(more).toEqual([]);
    expect(message!.embeds).toEqual([
      {
        author: { name: PLATFORM_SENDER },
        title: "Richiesta di approvazione",
        description:
          "«Matilde» chiede la tua approvazione per: invia una mail\n- A: anna@example.com\nLa richiesta scade oggi alle 18:00.",
        color: PLATFORM_COLOUR,
      },
    ]);
    expect(message!.components).toEqual([
      {
        type: 1,
        components: [{ type: 2, style: 5, label: "Approva o rifiuta", url: "https://acme.cerase.ai/a/Xy7Kq2" }],
      },
    ]);
    expect(message!.allowedMentions).toEqual({ parse: [] });
    // The address is in the button, not spelled out in the text.
    expect(JSON.stringify(message!.embeds)).not.toContain("https://");
  });

  it("makes a stranger's markdown literal, so a meeting's title cannot hide a link", () => {
    const [message] = discordNoticeMessages({ title: "T", body: "[premi](https://evil.example) **ora**\n# titolo" });
    expect(message!.embeds[0]!.description).toBe("\\[premi\\](https://evil.example) \\*\\*ora\\*\\*\n\\# titolo");
  });

  it("leaves an address in angle brackets as written, and escapes a quote only where it starts a line", () => {
    // A forwarded mail quotes its sender as «Erin <erin@example.com>». An
    // escaped closing bracket made Discord draw «erin@example.com\» as a
    // link with a stray backslash; only a «>» that opens a line is markdown.
    const [message] = discordNoticeMessages({
      title: "T",
      body: "- Testo: Da: Erin <erin@example.com>\n> citazione",
    });
    expect(message!.embeds[0]!.description).toBe("- Testo: Da: Erin <erin@example.com>\n\\> citazione");
  });

  it("spells the address out when Discord would refuse it as a button", () => {
    const long = `https://acme.cerase.ai/${"x".repeat(600)}`;
    const [message] = discordNoticeMessages({ title: "T", body: "testo", link: { url: long, label: "Apri" } });
    expect(message!.components).toEqual([]);
    expect(message!.embeds[0]!.description).toBe(`testo\nApri: ${long}`);
  });

  it("continues a body past one embed in further embeds, every character kept, the button on the last message", () => {
    const line = "- A: ".concat("r".repeat(990));
    const body = Array.from({ length: 12 }, () => line).join("\n");
    const messages = discordNoticeMessages({ ...APPROVAL, body });
    const described = messages.flatMap((m) => m.embeds.map((e) => e.description ?? "")).join("\n");
    expect(described).toBe(body);
    for (const m of messages) {
      const size = m.embeds.reduce((n, e) => n + (e.description?.length ?? 0) + (e.title?.length ?? 0), 0);
      expect(size).toBeLessThanOrEqual(6000);
      for (const e of m.embeds) expect((e.description ?? "").length).toBeLessThanOrEqual(4096);
    }
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.slice(0, -1).every((m) => m.components.length === 0)).toBe(true);
    expect(messages[messages.length - 1]!.components).toHaveLength(1);
    expect(messages[0]!.embeds[0]!.author).toEqual({ name: PLATFORM_SENDER });
  });
});

describe("Slack: blocks naming the platform, with a link button", () => {
  it("names the platform, heads with the title, says the body in plain text and links in a button", () => {
    const message = slackNoticeMessage(APPROVAL);
    expect(message.blocks).toEqual([
      { type: "context", elements: [{ type: "plain_text", text: "Cerase", emoji: false }] },
      { type: "header", text: { type: "plain_text", text: "Richiesta di approvazione", emoji: false } },
      { type: "section", text: { type: "plain_text", text: APPROVAL.body, emoji: false } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: SLACK_NOTICE_ACTION_ID,
            text: { type: "plain_text", text: "Approva o rifiuta", emoji: false },
            url: "https://acme.cerase.ai/a/Xy7Kq2",
          },
        ],
      },
    ]);
  });

  it("carries the notice spelled out, address included, as the text a notification shows", () => {
    expect(slackNoticeMessage(APPROVAL).text).toBe(noticeText(APPROVAL));
  });
});

describe("Google Chat: a card with the platform under its title, and a link button", () => {
  it("draws the title, the platform, the body and the button", () => {
    const message = googleChatNoticeMessage({ ...APPROVAL, body: "Riunione <Weekly> & co\nseconda riga" });
    expect(message.cardsV2).toEqual([
      {
        cardId: "platform-notice",
        card: {
          header: { title: "Richiesta di approvazione", subtitle: "Cerase" },
          sections: [
            {
              widgets: [
                { textParagraph: { text: "Riunione &lt;Weekly&gt; &amp; co<br>seconda riga" } },
                {
                  buttonList: {
                    buttons: [
                      { text: "Approva o rifiuta", onClick: { openLink: { url: "https://acme.cerase.ai/a/Xy7Kq2" } } },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    ]);
  });

  it("gives the phone's notification the notice spelled out, address included", () => {
    expect(googleChatNoticeMessage(APPROVAL).fallbackText).toBe(noticeText(APPROVAL));
  });
});

describe("Telegram: a quoted block under a bold heading, with a link button", () => {
  it("heads with the platform and the title in bold, quotes the body and puts the link in a button", () => {
    expect(telegramNoticeMessages(APPROVAL)).toEqual([
      {
        html: "<b>Cerase · Richiesta di approvazione</b>\n<blockquote>«Matilde» chiede la tua approvazione per: invia una mail\n- A: anna@example.com\nLa richiesta scade oggi alle 18:00.</blockquote>",
        button: { url: "https://acme.cerase.ai/a/Xy7Kq2", label: "Approva o rifiuta" },
      },
    ]);
  });

  it("makes the body literal for Telegram's HTML", () => {
    const [m] = telegramNoticeMessages({ title: "A <b>", body: "x < y & <i>z</i>" });
    expect(m!.html).toBe("<b>Cerase · A &lt;b&gt;</b>\n<blockquote>x &lt; y &amp; &lt;i&gt;z&lt;/i&gt;</blockquote>");
  });

  it("spells the address out under the quote when the button cannot be shown", () => {
    const [m] = telegramNoticeMessages(APPROVAL, true);
    expect(m!.button).toBeUndefined();
    expect(m!.html.endsWith("</blockquote>\nApprova o rifiuta: https://acme.cerase.ai/a/Xy7Kq2")).toBe(true);
  });
});

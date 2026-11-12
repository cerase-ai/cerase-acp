import { describe, expect, it } from "vitest";
import {
  discordNoticeMessages,
  googleChatNoticeMessage,
  noticeText,
  PLATFORM_COLOUR,
  PLATFORM_SENDER,
  type PlatformNotice,
  parseNoticeRef,
  parsePlatformNotice,
  SLACK_NOTICE_ACTION_ID,
  slackNoticeMessage,
  splitAtLines,
  telegramClosedNoticeMessage,
  telegramNoticeMessages,
} from "./platform-notice.js";
import { specTest } from "./test-support/spec-rows.js";

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
  specTest(
    "ACP-NOTICE-001",
    "draws the notice as one embed in the console's colour and the link as a button",
    (row) => {
      const title = row.quoted("when")[0]!;
      const notice: PlatformNotice = { ...APPROVAL, title };
      const [message, ...more] = discordNoticeMessages(notice);
      expect(more).toEqual([]);
      expect(message!.embeds).toEqual([
        {
          author: { name: PLATFORM_SENDER },
          title,
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

      const button = message!.components[0]?.components[0];
      const signedByPlatform = message!.embeds[0]?.author?.name === PLATFORM_SENDER;
      const linkAsButton = button !== undefined && "url" in button && button.url === notice.link!.url;
      const count = [message, ...more].length;
      const observed = `the bridge sends ${count === 1 ? "one" : String(count)} embed ${signedByPlatform ? "signed by the platform" : "not signed by the platform"} with ${linkAsButton ? "the link as a button" : "no link button"}`;
      expect(observed).toBe(row.expect);
    },
  );

  it("makes a stranger's markdown literal, so a meeting's title cannot hide a link", () => {
    const [message] = discordNoticeMessages({ title: "T", body: "[premi](https://evil.example) **ora**\n# titolo" });
    expect(message!.embeds[0]!.description).toBe("\\[premi\\](https://evil.example) \\*\\*ora\\*\\*\n\\# titolo");
  });

  specTest(
    "ACP-NOTICE-012",
    "leaves an address in angle brackets as written, and escapes a quote only where it starts a line",
    (row) => {
      // A forwarded mail quotes its sender as «Erin <erin@example.com>». An
      // escaped closing bracket made Discord draw «erin@example.com\» as a
      // link with a stray backslash; only a «>» that opens a line is markdown.
      const address = row.quoted("when")[0]!;
      const [message] = discordNoticeMessages({
        title: "T",
        body: `- Testo: Da: ${address}\n> citazione`,
      });
      const description = message!.embeds[0]!.description ?? "";
      expect(description).toBe(`- Testo: Da: ${address}\n\\> citazione`);

      const closingBracket = description.includes(address);
      const noEscape = !description.includes(address.replace(">", "\\>"));
      const quoteEscaped = description.includes("\n\\> citazione");
      const observed = `the address reaches the chat with ${closingBracket ? "its closing bracket" : "no closing bracket"} and ${noEscape ? "no escape character" : "an escape character"}, and ${quoteEscaped ? "only a quote sign opening a line is escaped" : "a quote sign is not escaped"}`;
      expect(observed).toBe(row.expect);
    },
  );

  specTest("ACP-NOTICE-005", "spells the address out when Discord would refuse it as a button", (row) => {
    const long = `https://acme.cerase.ai/${"x".repeat(600)}`;
    const [message] = discordNoticeMessages({ title: "T", body: "testo", link: { url: long, label: "Apri" } });
    expect(message!.components).toEqual([]);
    expect(message!.embeds[0]!.description).toBe(`testo\nApri: ${long}`);

    const spelledOut = message!.embeds[0]!.description?.includes(long) ?? false;
    const observed = spelledOut
      ? "the address is spelled out in the body"
      : "the address is not spelled out in the body";
    expect(observed).toBe(row.expect);
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
  specTest(
    "ACP-NOTICE-002",
    "names the platform, heads with the title, says the body in plain text and links in a button",
    (row) => {
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

      const [context, header, section, actions] = message.blocks as unknown as [
        { elements?: Array<{ text?: string }> },
        { text?: { text?: string } },
        { text?: { type?: string; text?: string } },
        { elements?: Array<{ url?: string }> },
      ];
      const namesPlatform = context.elements?.[0]?.text === PLATFORM_SENDER;
      const headsTitle = header.text?.text === APPROVAL.title;
      const bodyPlain = section.text?.type === "plain_text" && section.text?.text === APPROVAL.body;
      const linkButton = actions.elements?.[0]?.url === APPROVAL.link!.url;
      const observed = `the bridge sends blocks ${namesPlatform ? "naming the platform" : "not naming the platform"}, ${headsTitle ? "the title" : "no title"}, ${bodyPlain ? "the body in plain text" : "the body not in plain text"} and ${linkButton ? "a link button" : "no link button"}`;
      expect(observed).toBe(row.expect);
    },
  );

  it("carries the notice spelled out, address included, as the text a notification shows", () => {
    expect(slackNoticeMessage(APPROVAL).text).toBe(noticeText(APPROVAL));
  });
});

describe("Google Chat: a card with the platform under its title, and a link button", () => {
  specTest("ACP-NOTICE-004", "draws the title, the platform, the body and the button", (row) => {
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

    const card = message.cardsV2[0]!.card as {
      header?: { title?: string; subtitle?: string };
      sections?: Array<{ widgets?: Array<Record<string, unknown>> }>;
    };
    const titleInHeader = card.header?.title === APPROVAL.title;
    const platformAsSender = card.header?.subtitle === PLATFORM_SENDER;
    const buttonList = card.sections?.[0]?.widgets?.find((widget) => "buttonList" in widget) as
      | { buttonList: { buttons: Array<{ onClick?: { openLink?: { url?: string } } }> } }
      | undefined;
    const linkButton = buttonList?.buttonList.buttons[0]?.onClick?.openLink?.url === APPROVAL.link!.url;
    const observed = `the bridge sends a card with ${titleInHeader ? "the title in the header" : "no title in the header"}, ${platformAsSender ? "the platform as sender" : "no platform as sender"} and ${linkButton ? "a link button" : "no link button"}`;
    expect(observed).toBe(row.expect);
  });

  it("gives the phone's notification the notice spelled out, address included", () => {
    expect(googleChatNoticeMessage(APPROVAL).fallbackText).toBe(noticeText(APPROVAL));
  });
});

describe("Telegram: a quoted block under a bold heading, with a link button", () => {
  specTest(
    "ACP-NOTICE-003",
    "heads with the platform and the title in bold, quotes the body and puts the link in a button",
    (row) => {
      const messages = telegramNoticeMessages(APPROVAL);
      expect(messages).toEqual([
        {
          html: "<b>Cerase · Richiesta di approvazione</b>\n<blockquote>«Matilde» chiede la tua approvazione per: invia una mail\n- A: anna@example.com\nLa richiesta scade oggi alle 18:00.</blockquote>",
          button: { url: "https://acme.cerase.ai/a/Xy7Kq2", label: "Approva o rifiuta" },
        },
      ]);

      const [message] = messages;
      const html = message!.html;
      const boldHeading = html.startsWith("<b>") && html.includes(PLATFORM_SENDER) && html.includes(APPROVAL.title);
      const bodyQuoted = html.includes("<blockquote>") && html.includes("</blockquote>");
      const linkInButton = message!.button?.url === APPROVAL.link!.url;
      const observed = `the bridge sends a ${boldHeading ? "bold heading naming the platform and the title" : "heading"}, ${bodyQuoted ? "the body quoted" : "the body unquoted"}, and ${linkInButton ? "the link in a button" : "no button"}`;
      expect(observed).toBe(row.expect);
    },
  );

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

describe("a notice's reference, as the control-plane hands it back", () => {
  it("reads the reference of each channel", () => {
    expect(parseNoticeRef({ channel: "discord", channelId: "1", messageId: "2" })).toEqual({
      channel: "discord",
      channelId: "1",
      messageId: "2",
    });
    expect(parseNoticeRef({ channel: "slack", channelId: "D1", ts: "1.2" })).toEqual({
      channel: "slack",
      channelId: "D1",
      ts: "1.2",
    });
    expect(parseNoticeRef({ channel: "telegram", chatId: "42", messageId: 7 })).toEqual({
      channel: "telegram",
      chatId: "42",
      messageId: 7,
    });
    expect(parseNoticeRef({ channel: "workspace_chat", name: "spaces/A/messages/B" })).toEqual({
      channel: "workspace_chat",
      name: "spaces/A/messages/B",
    });
  });

  it("refuses one with a part missing, or of a channel it does not know", () => {
    expect(parseNoticeRef({ channel: "discord", channelId: "1" })).toBeUndefined();
    expect(parseNoticeRef({ channel: "telegram", chatId: "42", messageId: "7" })).toBeUndefined();
    expect(parseNoticeRef({ channel: "workspace_chat", name: "spaces/A" })).toBeUndefined();
    expect(parseNoticeRef({ channel: "web", id: "x" })).toBeUndefined();
    expect(parseNoticeRef(null)).toBeUndefined();
  });
});

describe("a closed notice keeps what it said, and its button says how it ended", () => {
  const notice = {
    title: "Richiesta di approvazione",
    body: "«Matilde» chiede la tua approvazione per: invia una mail",
    link: { url: "https://acme.cerase.ai/a/Xy7Kq2", label: "Approva o rifiuta" },
  };

  it("Slack and Google Chat keep the title and the body, and a button that still opens the page", () => {
    const slack = JSON.stringify(slackNoticeMessage(notice, "Scaduta").blocks);
    const chat = JSON.stringify(googleChatNoticeMessage(notice, "Scaduta").cardsV2);
    for (const drawn of [slack, chat]) {
      expect(drawn).toContain("Richiesta di approvazione");
      expect(drawn).toContain("chiede la tua approvazione");
      expect(drawn).toContain("Scaduta");
      expect(drawn).not.toContain("Approva o rifiuta");
      expect(drawn).toContain(notice.link.url);
      expect(drawn).not.toContain('"disabled":true');
    }
  });

  it("Telegram keeps the quote, and its button says how it ended", () => {
    const html = telegramClosedNoticeMessage(notice, "✓ Approvata");
    expect(html).toContain("<blockquote>");
    expect(html).not.toContain(notice.link.url);
  });
});

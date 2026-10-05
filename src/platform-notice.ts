// A notice the PLATFORM sends into a chat on its own account: an approval to
// give, a meeting the assistant is waiting in, a link to connect an account, a
// failure the person has to know about. The control-plane writes it; the
// assistant does not, and the person must never read it as the assistant's.
//
// Sent as plain text, beside the assistant's own messages and in the same
// typeface, «Matilde chiede la tua approvazione» read as if Matilde had said
// it. So each channel shows a notice in its own box: a Discord embed, Slack
// blocks, a Google Chat card, and on Telegram a quoted block under a bold
// heading. Each names the platform as its sender, and carries its link in a
// button.
//
// The address stays reachable wherever a button cannot be shown: in the plain
// text a channel puts in a notification, in a URL the channel would refuse as
// a button, and on a channel with no box at all, which receives `noticeText`.
//
// The messages the bridge itself writes, in the assistant's voice, are in
// platform-notices.ts and are not these.

/** The name a notice is signed with, on every channel. */
export const PLATFORM_SENDER = "Cerase";

/** The colour of a notice's box where the channel draws one: the console's own. */
export const PLATFORM_COLOUR = 0xdc2f47;

export interface NoticeLink {
  url: string;
  /** What the button says, e.g. «Approva o rifiuta». */
  label: string;
}

export interface PlatformNotice {
  /** What the notice is, in a few words: «Richiesta di approvazione». */
  title: string;
  /** What it says, as plain text; lines are kept. */
  body: string;
  link?: NoticeLink;
}

/**
 * The notice an `/internal/inject` body carries, or undefined when the value is
 * not one. Every string is required to be non-empty, the link's address to be
 * http or https: a notice that would render as an empty box, or a button that
 * opens nothing, is refused where it arrives rather than shown.
 */
export function parsePlatformNotice(value: unknown): PlatformNotice | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  const title = rec.title;
  const body = rec.body;
  if (typeof title !== "string" || title.trim() === "" || typeof body !== "string") return undefined;
  if (rec.link === undefined || rec.link === null) return { title, body };
  if (typeof rec.link !== "object") return undefined;
  const link = rec.link as Record<string, unknown>;
  if (typeof link.url !== "string" || !isWebAddress(link.url)) return undefined;
  if (typeof link.label !== "string" || link.label.trim() === "") return undefined;
  return { title, body, link: { url: link.url, label: link.label } };
}

/** An http or https address, the only kind every channel opens from a button. */
export function isWebAddress(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/** The heading every rendering opens with: the sender, then what the notice is. */
export function noticeHeading(notice: PlatformNotice): string {
  return `${PLATFORM_SENDER} · ${notice.title}`;
}

/** The link as a line of text: its label and its address, spelled out. */
export function linkLine(link: NoticeLink): string {
  return `${link.label}: ${link.url}`;
}

/**
 * The notice as plain text, for a channel with no box and for the text a
 * channel shows in a notification: the heading, the body, and the link's
 * address spelled out.
 */
export function noticeText(notice: PlatformNotice): string {
  return [noticeHeading(notice), notice.body.trim(), notice.link ? linkLine(notice.link) : ""]
    .filter((part) => part !== "")
    .join("\n");
}

/**
 * `text` cut into pieces of at most `max` characters, at line ends where it
 * can be and inside a line only where one line is longer than `max`. Every
 * character is kept: a notice lists a mail's recipients whole, and a cut
 * address is the one thing on it the person cannot check elsewhere.
 */
export function splitAtLines(text: string, max: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    let rest = line;
    while (rest.length > max) {
      if (current !== "") {
        pieces.push(current);
        current = "";
      }
      pieces.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    const joined = current === "" ? rest : `${current}\n${rest}`;
    if (joined.length > max) {
      pieces.push(current);
      current = rest;
    } else {
      current = joined;
    }
  }
  if (current !== "" || pieces.length === 0) pieces.push(current);
  return pieces;
}

// ── Discord ────────────────────────────────────────────────────────────────

/** One message to send on Discord: embeds, and the link button on the last. */
export interface DiscordNoticeMessage {
  embeds: Array<{
    author?: { name: string };
    title?: string;
    description?: string;
    color: number;
  }>;
  components: Array<{
    type: 1;
    components: Array<{ type: 2; style: 5; label: string; url: string }>;
  }>;
  allowedMentions: { parse: never[] };
}

// Discord's limits: an embed description holds 4,096 characters, a message's
// embeds 6,000 together, a button's label 80 and its address 512. Kept under
// them with a margin for the title and the author.
const DISCORD_DESCRIPTION_MAX = 4000;
const DISCORD_MESSAGE_TEXT_MAX = 5600;
const DISCORD_LABEL_MAX = 80;
const DISCORD_BUTTON_URL_MAX = 512;

/**
 * Discord markdown made literal, so a meeting's title cannot become a link, a
 * quote or a heading. A line's leading «- » is left alone: the body lists an
 * action's arguments that way, and Discord drawing them as a list is right.
 */
export function escapeDiscordMarkdown(text: string): string {
  return text.replace(/([\\*_~`|>[\]])/g, "\\$1").replace(/^(\s*)#/gm, "$1\\#");
}

/**
 * The notice as Discord messages: an embed signed by the platform and drawn in
 * its colour, and a link button under it. Almost always one message; a body
 * past what one embed holds continues in further embeds, and past what one
 * message holds in further messages, with the button on the last.
 */
export function discordNoticeMessages(notice: PlatformNotice): DiscordNoticeMessage[] {
  const button =
    notice.link && notice.link.url.length <= DISCORD_BUTTON_URL_MAX
      ? { label: truncate(notice.link.label, DISCORD_LABEL_MAX), url: notice.link.url }
      : undefined;
  // A link Discord would refuse as a button is spelled out under the body,
  // its address left as it is so that Discord still links it.
  const escaped = escapeDiscordMarkdown(notice.body.trim());
  const body =
    notice.link && !button
      ? [escaped, `${escapeDiscordMarkdown(notice.link.label)}: ${notice.link.url}`].filter((l) => l !== "").join("\n")
      : escaped;
  const pieces = body === "" ? [""] : splitAtLines(body, DISCORD_DESCRIPTION_MAX);

  const messages: DiscordNoticeMessage[] = [];
  let embeds: DiscordNoticeMessage["embeds"] = [];
  let size = 0;
  pieces.forEach((piece, i) => {
    const embed: DiscordNoticeMessage["embeds"][number] = { color: PLATFORM_COLOUR };
    if (i === 0) {
      embed.author = { name: PLATFORM_SENDER };
      embed.title = truncate(notice.title, 256);
    }
    if (piece !== "") embed.description = piece;
    const weight = piece.length + (embed.title?.length ?? 0) + PLATFORM_SENDER.length;
    if (embeds.length > 0 && (size + weight > DISCORD_MESSAGE_TEXT_MAX || embeds.length === 10)) {
      messages.push({ embeds, components: [], allowedMentions: { parse: [] } });
      embeds = [];
      size = 0;
    }
    embeds.push(embed);
    size += weight;
  });
  messages.push({
    embeds,
    components: button ? [{ type: 1, components: [{ type: 2, style: 5, ...button }] }] : [],
    allowedMentions: { parse: [] },
  });
  return messages;
}

// ── Slack ──────────────────────────────────────────────────────────────────

/** The action id Slack reports a click on a notice's button under. */
export const SLACK_NOTICE_ACTION_ID = "cerase_platform_notice_link";

export interface SlackNoticeMessage {
  /** What Slack shows in a notification, and where blocks cannot be drawn. */
  text: string;
  blocks: Array<Record<string, unknown>>;
}

// Slack's limits: a header holds 150 characters, a section's text 3,000, a
// button's text 75 and its address 3,000, a message 50 blocks.
const SLACK_SECTION_MAX = 3000;

/**
 * The notice as Slack blocks: the platform's name, the title as a header, the
 * body in plain-text sections, so nothing in it is read as markup, and the
 * link as a button. The message's text is the notice spelled out, address
 * included, which is what Slack shows in a notification.
 */
export function slackNoticeMessage(notice: PlatformNotice): SlackNoticeMessage {
  const button = notice.link && notice.link.url.length <= 3000 ? notice.link : undefined;
  const body = notice.link && !button ? `${notice.body.trim()}\n${linkLine(notice.link)}` : notice.body.trim();
  const blocks: Array<Record<string, unknown>> = [
    { type: "context", elements: [{ type: "plain_text", text: PLATFORM_SENDER, emoji: false }] },
    { type: "header", text: { type: "plain_text", text: truncate(notice.title, 150), emoji: false } },
  ];
  if (body !== "") {
    for (const piece of splitAtLines(body, SLACK_SECTION_MAX).slice(0, 46)) {
      blocks.push({ type: "section", text: { type: "plain_text", text: piece, emoji: false } });
    }
  }
  if (button) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: SLACK_NOTICE_ACTION_ID,
          text: { type: "plain_text", text: truncate(button.label, 75), emoji: false },
          url: button.url,
        },
      ],
    });
  }
  return { text: noticeText(notice), blocks };
}

// ── Google Chat ────────────────────────────────────────────────────────────

export interface GoogleChatNoticeMessage {
  /** The plain text Chat shows where the card cannot be: a phone's notification. */
  fallbackText: string;
  cardsV2: Array<{ cardId: string; card: Record<string, unknown> }>;
}

/** Text made literal for a card's text paragraph, which reads a few HTML tags. */
function escapeCardHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
}

/**
 * The notice as a Google Chat card: the title in the header, the platform's
 * name under it, the body as a paragraph and the link as a button. The
 * fallback text is the notice spelled out, which is what a phone's
 * notification shows.
 */
export function googleChatNoticeMessage(notice: PlatformNotice): GoogleChatNoticeMessage {
  const widgets: Array<Record<string, unknown>> = [];
  const body = notice.body.trim();
  if (body !== "") widgets.push({ textParagraph: { text: escapeCardHtml(body) } });
  if (notice.link) {
    widgets.push({
      buttonList: {
        buttons: [{ text: notice.link.label, onClick: { openLink: { url: notice.link.url } } }],
      },
    });
  }
  return {
    fallbackText: noticeText(notice),
    cardsV2: [
      {
        cardId: "platform-notice",
        card: {
          header: { title: notice.title, subtitle: PLATFORM_SENDER },
          sections: widgets.length > 0 ? [{ widgets }] : [],
        },
      },
    ],
  };
}

// ── Telegram ───────────────────────────────────────────────────────────────

export interface TelegramNoticeMessage {
  /** HTML, as Telegram's parse_mode HTML reads it. */
  html: string;
  /** The button under the last message, when the notice has a link. */
  button?: NoticeLink;
}

// Telegram's limit is 4,096 characters of text after the markup is read; the
// heading and the tags around the quote are kept out of the share.
const TELEGRAM_QUOTE_MAX = 3800;

function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The notice as Telegram messages: a bold heading naming the platform, the
 * body in a quoted block, and the link as a button under the last. With
 * `withoutButton`, for when Telegram refused the button, the address is
 * spelled out under the quote instead.
 */
export function telegramNoticeMessages(notice: PlatformNotice, withoutButton = false): TelegramNoticeMessage[] {
  const heading = `<b>${escapeTelegramHtml(noticeHeading(notice))}</b>`;
  const body = notice.body.trim();
  const pieces = body === "" ? [] : splitAtLines(body, TELEGRAM_QUOTE_MAX);
  const messages: TelegramNoticeMessage[] =
    pieces.length === 0
      ? [{ html: heading }]
      : pieces.map((piece, i) => ({
          html: `${i === 0 ? `${heading}\n` : ""}<blockquote>${escapeTelegramHtml(piece)}</blockquote>`,
        }));
  if (notice.link) {
    const last = messages[messages.length - 1]!;
    if (withoutButton) {
      last.html += `\n${escapeTelegramHtml(linkLine(notice.link))}`;
    } else {
      last.button = notice.link;
    }
  }
  return messages;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

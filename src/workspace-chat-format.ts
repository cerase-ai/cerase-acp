// Markdown to Google Chat's text markup, and an answer to the messages that
// carry it.
//
// Chat renders *bold*, _italic_, ~strike~, `code`, fenced blocks and <url|text>
// links, and nothing else: Markdown's double-asterisk bold shows as literal asterisks.
// The assistant writes Markdown on every channel, so a reply bound for Chat is
// translated here, once, on the way out. Code, inline and fenced, is left as
// written: an asterisk inside it is content, not markup.
//
// An answer on Chat is one message, and a message holds at most 32,000 bytes,
// text and cards together (developers.google.com/workspace/chat/create-messages).
// An answer larger than that is the one that goes out in more than one.

import { CONTINUATION } from "./send-queue.js";

const PLACEHOLDER = "\u0000";

/** The most one Google Chat message may hold, text and cards together, in bytes. */
export const CHAT_MESSAGE_MAX_BYTES = 32_000;

// What a part of an answer may hold, as the Chat text it is posted as. The rest
// of the 32,000 is left for what the send path does after the cut: the approval
// link replaces a 17-character placeholder with an address.
const CHAT_PART_MAX_BYTES = CHAT_MESSAGE_MAX_BYTES - 2_000;

/** Translates one reply chunk from Markdown to Google Chat's markup. */
export function toChatText(markdown: string): string {
  const kept: string[] = [];
  const keep = (s: string): string => {
    kept.push(s);
    return `${PLACEHOLDER}${kept.length - 1}${PLACEHOLDER}`;
  };

  let text = markdown.replace(/```[\s\S]*?```/g, keep).replace(/`[^`\n]+`/g, keep);

  text = text
    .split("\n")
    .map((line) => {
      const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) return keep(`*${heading[1]}*`);
      return line.replace(/^(\s*)[-*+]\s+/, "$1• ");
    })
    .join("\n");

  text = text
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => keep(`<${url}|${label}>`))
    .replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, (_m, inner: string) => keep(`*${inner}*`))
    .replace(/(?<![\w_])__(?=\S)([^_\n]+?)(?<=\S)__(?![\w_])/g, (_m, inner: string) => keep(`*${inner}*`))
    .replace(/~~(?=\S)([^~\n]+?)(?<=\S)~~/g, "~$1~")
    .replace(/(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, "_$1_");

  const restore = new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, "g");
  // Twice: a kept heading or link can itself hold a kept code span.
  for (let i = 0; i < 2; i++) {
    text = text.replace(restore, (_m, n: string) => kept[Number(n)] ?? "");
  }
  return text;
}

/** The size of `markdown` once it is posted to Chat, in UTF-8 bytes. */
function chatBytes(markdown: string): number {
  return Buffer.byteLength(toChatText(markdown), "utf8");
}

/**
 * Cuts one answer into the Google Chat messages that carry it: the answer
 * whole, unless its Chat text is larger than a message may be. Then each part
 * is as large as fits, cut where a line ends, or else where a sentence does,
 * and ends with the continuation mark Discord's parts carry.
 */
export function splitForGoogleChat(text: string): string[] {
  if (!text) return [];
  const parts: string[] = [];
  let rest = text;
  const room = CHAT_PART_MAX_BYTES - Buffer.byteLength(CONTINUATION, "utf8");
  while (chatBytes(rest) > CHAT_PART_MAX_BYTES) {
    const fits = longestPrefixWithin(rest, room);
    const window = rest.slice(0, fits);
    let cut = window.lastIndexOf("\n");
    if (cut < fits / 2) {
      cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
      if (cut > 0) cut += 1;
    }
    if (cut < fits / 2) cut = fits;
    parts.push(rest.slice(0, cut).trimEnd() + CONTINUATION);
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

/**
 * The length of the longest start of `text` whose Chat text fits in `bytes`,
 * never ending between the two halves of a character outside the basic plane.
 */
function longestPrefixWithin(text: string, bytes: number): number {
  let fits = 0;
  let over = text.length + 1;
  while (over - fits > 1) {
    const mid = Math.floor((fits + over) / 2);
    if (chatBytes(text.slice(0, mid)) <= bytes) fits = mid;
    else over = mid;
  }
  const last = text.charCodeAt(fits - 1);
  return fits > 0 && last >= 0xd800 && last <= 0xdbff ? fits - 1 : fits;
}

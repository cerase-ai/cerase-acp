// Markdown to Google Chat's text markup.
//
// Chat renders *bold*, _italic_, ~strike~, `code`, fenced blocks and <url|text>
// links, and nothing else: Markdown's double-asterisk bold shows as literal asterisks.
// The assistant writes Markdown on every channel, so a reply bound for Chat is
// translated here, once, on the way out. Code, inline and fenced, is left as
// written: an asterisk inside it is content, not markup.

const PLACEHOLDER = "\u0000";

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

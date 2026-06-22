import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// M-ACP-2 — typing feedback beyond Discord. Telegram bots signal
// activity via sendChatAction("typing"), which Telegram displays for
// ~5s — the adapter must keep it alive for the duration of the turn
// (the shared startTypingKeepalive ticks faster than that window).
// Structural test, matching the discord-adapter test style: the
// adapter needs a live platform to exercise behaviourally.
describe("telegram typing keepalive (M-ACP-2)", () => {
  const src = readFileSync(fileURLToPath(new URL("./telegram-adapter.ts", import.meta.url)), "utf8");

  it("wires startTypingKeepalive around the text handler", () => {
    expect(src).toContain("startTypingKeepalive");
    expect(src).toContain("sendChatAction");
  });

  it("stops the keepalive on every exit path (finally)", () => {
    expect(src).toMatch(/finally\s*\{[^}]*stopTyping/);
  });
});

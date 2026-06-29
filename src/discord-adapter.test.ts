import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Structural pin for the OPT-67 fix. Testing makeSendTarget end-to-end
// requires a full discord.js client harness (mock channel, DM creation,
// event loop); the regression we care about is whether the post-
// channel.send sendTyping ever comes back. A grep over the source is
// exactly the right level — it catches a future commit that re-adds
// the line without setting up a real Discord test runtime.

const here = dirname(fileURLToPath(import.meta.url));
const adapter = readFileSync(join(here, "discord-adapter.ts"), "utf8");

describe("discord-adapter (OPT-67 invariants)", () => {
  it("does NOT call channel.sendTyping() inside makeSendTarget after channel.send()", () => {
    // Locate the makeSendTarget block. It's the only place where a
    // post-send sendTyping would re-introduce the bug.
    const start = adapter.indexOf("makeSendTarget(");
    expect(start).toBeGreaterThan(0);
    // Block ends at the closing `};` of the returned async function.
    // Take a generous window after `makeSendTarget(` to capture the
    // entire returned closure.
    const block = adapter.slice(start, start + 1500);

    // The only acceptable sendTyping inside discord-adapter.ts is the
    // INITIAL one fired by startTypingKeepalive (in the MessageCreate
    // handler, NOT in makeSendTarget). Any sendTyping call within
    // makeSendTarget reintroduces the trailing-typing ghost.
    const occurrences = (block.match(/sendTyping\s*\(/g) ?? []).length;
    expect(occurrences).toBe(0);
  });

  it("startTypingKeepalive is imported + used in the MessageCreate flow", () => {
    expect(adapter).toMatch(/import\s*\{[^}]*startTypingKeepalive[^}]*\}/);
    expect(adapter).toMatch(/startTypingKeepalive\(/);
  });

  it("stopTyping is invoked in a finally block (no leak on dispatcher throw)", () => {
    expect(adapter).toMatch(/finally\s*\{[\s\S]*?stopTyping\(\)/);
  });
});

// Cross-adapter invariant (per chat-adapter.ts OPT-67 contract). Any
// adapter that EVER adds a typing-indicator pattern (Discord
// `sendTyping`, Telegram `sendChatAction('typing')`, Slack assistant
// thread status, Workspace Chat) must follow the same shape:
//   - keepalive started in the message handler
//   - NO per-chunk re-trigger inside makeSendTarget
//   - stop invoked in a finally block
// This test scans each adapter file structurally. It does NOT require
// the typing affordance to exist (slack/telegram/workspace can skip
// the indicator entirely); it only fires when an adapter DOES use one.
describe("cross-adapter typing invariants (OPT-67)", () => {
  const adapterFiles = ["telegram-adapter.ts", "slack-adapter.ts", "workspace-chat-adapter.ts"];

  for (const fname of adapterFiles) {
    it(`${fname}: if a typing API is used, it is NOT called inside makeSendTarget`, () => {
      const src = readFileSync(join(here, fname), "utf8");
      const typingApis = [/sendTyping\s*\(/, /sendChatAction\s*\(\s*['"]typing['"]/, /setStatus\s*\(\s*\{[^}]*typing/i];
      const usesTyping = typingApis.some((rx) => rx.test(src));
      if (!usesTyping) {
        // No typing UX in this adapter yet — nothing to enforce.
        return;
      }
      const start = src.indexOf("makeSendTarget(");
      if (start < 0) return;
      const block = src.slice(start, start + 1500);
      for (const rx of typingApis) {
        expect(block).not.toMatch(rx);
      }
    });
  }
});

// M-FILE-LIMITS-1 (fail-loud). Every real adapter that ingests inbound
// attachments must, when the size cap rejects a file, TELL the user instead
// of dropping it silently. Driving the wired-in SDK handlers end-to-end needs
// a full discord.js / telegraf / @slack/bolt / googleapis harness (the same
// reason the OPT-67 tests above grep the source); a structural pin is the
// right level here. The notice-building + cap logic itself is covered
// behaviourally in inbound-attachments.test.ts (buildOversizeNotice + ingest
// `rejected` shape). This guards that each adapter actually CALLS it.
describe("cross-adapter fail-loud on oversize attachment (M-FILE-LIMITS-1)", () => {
  // Each adapter must pass its own channel literal so the effective per-channel
  // cap (min(setting, channel ceiling)) and the oversize notice's MB figure are
  // computed for the right platform.
  const channelByAdapter: Record<string, string> = {
    "discord-adapter.ts": "discord",
    "telegram-adapter.ts": "telegram",
    "slack-adapter.ts": "slack",
    "workspace-chat-adapter.ts": "workspace-chat",
  };

  for (const [fname, channel] of Object.entries(channelByAdapter)) {
    it(`${fname}: imports buildOversizeNotice and delivers it via sendSystemMessage`, () => {
      const src = readFileSync(join(here, fname), "utf8");
      // Imported from the shared module…
      expect(src).toMatch(/import\s*\{[^}]*buildOversizeNotice[^}]*\}\s*from\s*"\.\/inbound-attachments\.js"/);
      // …called on the ingest `rejected` set, with this adapter's channel literal…
      expect(src).toMatch(new RegExp(`buildOversizeNotice\\([^)]*"${channel}"`));
      // …the ingest itself also passes the channel literal…
      expect(src).toMatch(new RegExp(`ingestInbound(?:Attachments|Buffers)\\([^;]*"${channel}"`));
      // …and the resulting notice is sent to the user (not just logged).
      expect(src).toMatch(/sendSystemMessage\(/);
    });
  }
});

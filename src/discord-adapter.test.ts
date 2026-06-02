import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

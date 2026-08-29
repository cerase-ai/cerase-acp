import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Structural pins for the typing-indicator wiring. Driving makeSendTarget
// end-to-end requires a full discord.js client harness (mock channel, DM
// creation, event loop); what this file can pin is that the adapter uses the
// pieces in the right order. The behaviour those pieces have — a refresh
// never reaching the channel after a message, an in-flight refresh landing
// before it — is asserted for real against a fake channel in
// typing-keepalive.test.ts, which is where the ordering logic lives.

const here = dirname(fileURLToPath(import.meta.url));
const adapter = readFileSync(join(here, "discord-adapter.ts"), "utf8");

describe("discord-adapter (OPT-67 invariants)", () => {
  const sendTargetAt = adapter.indexOf("makeSendTarget(");
  const sendFileAt = adapter.indexOf("async sendFile(");
  // makeSendTarget is the last member of the returned adapter, so its block
  // runs to the end of the file. sendFile is the member just above it.
  const sendTargetBlock = adapter.slice(sendTargetAt);
  const sendFileBlock = adapter.slice(sendFileAt, sendTargetAt);

  it("does NOT call channel.sendTyping() inside makeSendTarget after channel.send()", () => {
    expect(sendTargetAt).toBeGreaterThan(0);
    // The only acceptable sendTyping in this file is the one the keepalive
    // fires from the MessageCreate handler. Any call inside makeSendTarget
    // reintroduces the trailing-typing ghost.
    const occurrences = (sendTargetBlock.match(/sendTyping\s*\(/g) ?? []).length;
    expect(occurrences).toBe(0);
  });

  it("the send target ends the turn's keepalive BEFORE handing the chunk to the channel", () => {
    // The order is the fix. Ending it after the send — which is what the
    // handler's finally block did — leaves a refresh free to arrive after the
    // message and raise the indicator again for another ten seconds.
    const ended = sendTargetBlock.indexOf("await typing.end(userId)");
    const sent = sendTargetBlock.indexOf("await channel.send(chunk)");
    expect(ended).toBeGreaterThan(-1);
    expect(sent).toBeGreaterThan(-1);
    expect(ended).toBeLessThan(sent);
  });

  it("the file-upload path ends the keepalive before uploading", () => {
    const ended = sendFileBlock.indexOf("await typing.end(userId)");
    const sent = sendFileBlock.indexOf("await channel.send(");
    expect(ended).toBeGreaterThan(-1);
    expect(sent).toBeGreaterThan(-1);
    expect(ended).toBeLessThan(sent);
  });

  it("the keepalive is registered per user so the send path can reach it", () => {
    expect(adapter).toMatch(/import\s*\{[^}]*TypingSessions[^}]*\}/);
    expect(adapter).toMatch(/new TypingSessions\(\)/);
    expect(adapter).toMatch(/typing\.start\(userId,/);
  });

  it("stopTyping is invoked in a finally block (no leak on dispatcher throw)", () => {
    expect(adapter).toMatch(/finally\s*\{[\s\S]*?stopTyping\(\)/);
  });

  it("the oversize notice is delivered before the indicator is raised", () => {
    // The notice is a message, and a message is what takes the indicator
    // down. Raising it first would spend it on the notice and leave the model
    // turn behind it with none.
    const notice = adapter.indexOf("sendSystemMessage(agent.id, userId, notice)");
    const raised = adapter.indexOf("typing.start(userId,");
    expect(notice).toBeGreaterThan(-1);
    expect(raised).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(raised);
  });
});

// The reachability wiring. What the monitor DOES is asserted behaviourally in
// reachability.test.ts, and what the bridge publishes in bridge.test.ts; what
// is left here is that this adapter reaches for it at all — the failure being
// guarded is a future edit that puts the cached client flag back on its own.
describe("discord-adapter reports reachability, not a cached flag", () => {
  it("readiness is the client flag AND the measurement", () => {
    expect(adapter).toMatch(/import\s*\{[^}]*isChannelReady[^}]*\}/);
    expect(adapter).toMatch(/isChannelReady\(client\.isReady\(\), reachability\.snapshot\(\)\)/);
  });

  it("the probe is unauthenticated, so a refused token is not read as an outage", () => {
    // A rejected credential is reported on its own, and it names the value to
    // fix. Letting it also blank out reachability would put one failure under
    // two names and send an operator to the wrong one.
    expect(adapter).toMatch(/Routes\.gateway\(\),\s*\{\s*auth:\s*false\s*\}/);
  });

  it("the monitor runs for exactly as long as the client does", () => {
    const startBlock = adapter.slice(adapter.indexOf("async start()"), adapter.indexOf("async stop()"));
    const stopBlock = adapter.slice(adapter.indexOf("async stop()"), adapter.indexOf("async sendFile("));
    expect(startBlock).toMatch(/reachability\.start\(\)/);
    expect(stopBlock).toMatch(/reachability\.stop\(\)/);
  });

  it("real traffic counts as evidence, so a talking bridge barely probes", () => {
    // Both directions: an inbound DM in the message handler, and a delivered
    // chunk in the send target.
    expect((adapter.match(/reachability\.note\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
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

// Every real adapter that ingests inbound attachments must, when the size
// cap rejects a file, tell the user instead of dropping it silently. Driving
// the wired-in SDK handlers end-to-end needs a full discord.js / telegraf /
// @slack/bolt / googleapis harness (the same reason the tests above grep the
// source); a structural pin is the right level here. The notice-building +
// cap logic itself is covered behaviourally in inbound-attachments.test.ts
// (buildOversizeNotice + ingest `rejected` shape). This guards that each
// adapter actually calls it.
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

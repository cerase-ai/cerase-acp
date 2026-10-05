import { describe, expect, it } from "vitest";
import type { DeliveryResult } from "./chat-adapter.js";
import type { BridgeConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import { noticeText, type PlatformNotice } from "./platform-notice.js";
import type { SessionManager } from "./session-manager.js";
import { TurnMetaTracker } from "./turn-meta.js";

// The dispatcher hands a platform notice to the adapter that can draw it in
// its channel's box, and to any other channel as the notice spelled out.

const CONFIG = { agents: [], session: { idle_timeout_minutes: 60, max_concurrent: 4 } } as unknown as BridgeConfig;

const NOTICE: PlatformNotice = {
  title: "Collega il tuo account",
  body: "Per usare Gmail collega il tuo account.",
  link: { url: "https://acme.cerase.ai/connect/tok", label: "Collega Gmail" },
};

function dispatcher(noticeTarget: ((notice: PlatformNotice) => Promise<DeliveryResult>) | undefined) {
  const texts: Array<[string, string, string]> = [];
  const d = new Dispatcher({
    config: CONFIG,
    sessionManager: {} as unknown as SessionManager,
    turnMeta: new TurnMetaTracker(),
    resolveSendTarget: (agentId, userId) => async (chunk) => {
      texts.push([agentId, userId, chunk]);
      return { ok: true };
    },
    resolveNoticeTarget: () => noticeTarget,
  });
  return { d, texts };
}

describe("Dispatcher.sendNotice", () => {
  it("gives the notice to an adapter that draws notices", async () => {
    const drawn: PlatformNotice[] = [];
    const { d, texts } = dispatcher(async (notice) => {
      drawn.push(notice);
      return { ok: true };
    });
    expect(await d.sendNotice("agent-1", "u1", NOTICE)).toEqual({ ok: true });
    expect(drawn).toEqual([NOTICE]);
    expect(texts).toEqual([]);
  });

  it("sends the notice spelled out, address included, where the adapter draws none", async () => {
    const { d, texts } = dispatcher(undefined);
    expect(await d.sendNotice("agent-1", "u1", NOTICE)).toEqual({ ok: true });
    expect(texts).toEqual([["agent-1", "u1", noticeText(NOTICE)]]);
  });

  it("reports the adapter's failure", async () => {
    const error = new Error("refused");
    const { d } = dispatcher(async () => ({ ok: false, error }));
    expect(await d.sendNotice("agent-1", "u1", NOTICE)).toEqual({ ok: false, error });
  });
});

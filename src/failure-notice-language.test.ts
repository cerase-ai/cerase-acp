import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import type { SessionManager } from "./session-manager.js";
import { TurnMetaTracker } from "./turn-meta.js";

// A two-word message carries no stopword, the detector says "unknown", and
// "unknown" was English: a failed turn answered in the wrong language.

function cfg(locale?: "it" | "en" | "es" | "fr"): BridgeConfig {
  return {
    agents: [
      {
        id: "a",
        channel: "discord",
        cwd: "/home/agent/cerase/workspace",
        mode: "cerase",
        bot_token: "x",
        allowed_users: ["u"],
        spawn: { command: "true", args: [] },
      },
    ],
    session: { idle_timeout_minutes: 60, max_concurrent: 4 },
    ...(locale ? { locale } : {}),
  };
}

function failing(): SessionManager {
  return {
    prompt: async () => {
      throw new Error("boom");
    },
  } as unknown as SessionManager;
}

async function failureNotice(config: BridgeConfig, turns: string[]): Promise<string> {
  const sent: string[] = [];
  const turnMeta = new TurnMetaTracker();
  const d = new Dispatcher({
    config,
    sessionManager: failing(),
    turnMeta,
    resolveSendTarget: () => async (text) => {
      sent.push(text);
      return { ok: true };
    },
  });
  for (const t of turns) await d.handleMessage("a", "u", t);
  const notice = sent.at(-1);
  if (notice === undefined) throw new Error("no failure notice was sent");
  return notice;
}

describe("a failed turn's notice", () => {
  it("keeps the conversation's language on a message too short to detect", async () => {
    const text = await failureNotice(cfg(), ["ciao, come ti chiami?", "vedi contatti?"]);
    expect(text).toMatch(/errore|riprova/i);
  });

  it("falls back to the organisation's language when nothing was ever detected", async () => {
    const text = await failureNotice(cfg("it"), ["vedi contatti?"]);
    expect(text).toMatch(/errore|riprova/i);
  });

  it("still answers in the detected language when the message says which", async () => {
    const text = await failureNotice(cfg("it"), ["can you help me with the document please"]);
    expect(text).toMatch(/went wrong/i);
  });
});

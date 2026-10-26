import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import { type SessionManager, TurnWatchdogError } from "./session-manager.js";
import { TurnMetaTracker } from "./turn-meta.js";

// A failed turn tells the person what happened. A scheduled message has no
// one reading the bridge's result, so the same copy travels back on the failed
// DeliveryResult for the caller to report to the control-plane.

function cfg(): BridgeConfig {
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
    locale: "it",
  };
}

function failing(error: Error): SessionManager {
  return {
    prompt: async () => {
      throw error;
    },
  } as unknown as SessionManager;
}

async function failedTurn(error: Error): Promise<{
  result: { ok: boolean; notice?: string; error?: Error };
  sent: string[];
}> {
  const sent: string[] = [];
  const d = new Dispatcher({
    config: cfg(),
    sessionManager: failing(error),
    turnMeta: new TurnMetaTracker(),
    resolveSendTarget: () => async (text) => {
      sent.push(text);
      return { ok: true };
    },
  });
  const result = (await d.handleMessage("a", "u", "controlla la posta")) as {
    ok: boolean;
    notice?: string;
    error?: Error;
  };
  return { result, sent };
}

describe("a failed turn reports the copy the person was sent", () => {
  it("carries the failure copy when the watchdog ended a silent turn", async () => {
    const copy = "Si è verificato un errore, riprova tra poco.";
    const { result, sent } = await failedTurn(new TurnWatchdogError("silent", 180_000));

    expect(result.ok).toBe(false);
    expect(result.notice).toBe(copy);
    expect(sent).toContain(copy);
  });

  it("carries the too-long copy when the watchdog ended a turn at its ceiling", async () => {
    const copy =
      "Ci stavo lavorando ma ho superato il tempo massimo per una singola richiesta. Prova a spezzarla in due, oppure chiedimi la parte che ti serve per prima.";
    const { result, sent } = await failedTurn(new TurnWatchdogError("ceiling", 2_700_000));

    expect(result.ok).toBe(false);
    expect(result.notice).toBe(copy);
    expect(sent).toContain(copy);
  });
});

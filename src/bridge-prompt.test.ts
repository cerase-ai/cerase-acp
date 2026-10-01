// Every prompt the bridge sends on its own is recognised as the bridge's by the
// rule the console applies, and nothing a person writes is.
//
// The examples are cerase-core's, the file its console suite reads, vendored
// here and pinned in scripts/TOOLING.sha256: the two halves of the rule are
// held to one set of examples rather than two that could drift apart.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type AttachFailure, AttachOutcomeTracker, attachFailurePrompt } from "./attach-outcome.js";
import { bridgePromptLine, isBridgePrompt } from "./bridge-prompt.js";
import type { BridgeConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import type { SessionManager, SessionUpdateHandler } from "./session-manager.js";
import { toolCallMarkupRetryPrompt } from "./tool-call-markup.js";
import { TurnMetaTracker } from "./turn-meta.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = "control-plane/tests/fixtures/bridge-prompts.json";

interface Fixture {
  bridge: { name: string; made_by: string; text: string; failures?: AttachFailure[] }[];
  person: { name: string; text: string; shown: string }[];
}

const fixture = JSON.parse(readFileSync(join(repoRoot, FIXTURE), "utf8")) as Fixture;

/** What makes each prompt the bridge sends on its own, by the name the fixture gives it. */
const MAKERS: Record<string, (entry: Fixture["bridge"][number]) => string> = {
  "toolCallMarkupRetryPrompt()": () => toolCallMarkupRetryPrompt(),
  "attachFailurePrompt(failures)": (entry) => attachFailurePrompt(entry.failures ?? []),
};

describe("the examples the console is tested on", () => {
  it("are pinned to the copy cerase-core wrote", () => {
    const pin = readFileSync(join(repoRoot, "scripts", "TOOLING.sha256"), "utf8");
    expect(pin).toMatch(new RegExp(`^[0-9a-f]{64}  ${FIXTURE}$`, "m"));
  });

  it("hold every prompt the bridge sends on its own, exactly as it sends it", () => {
    expect(fixture.bridge.map((e) => e.made_by).sort()).toEqual(Object.keys(MAKERS).sort());
    for (const entry of fixture.bridge) {
      expect(MAKERS[entry.made_by]?.(entry), entry.name).toBe(entry.text);
    }
  });

  it("are told apart by the rule: every prompt of the bridge's is recognised, no message of a person's is", () => {
    for (const entry of fixture.bridge) expect(isBridgePrompt(entry.text), entry.name).toBe(true);
    for (const entry of fixture.person) expect(isBridgePrompt(entry.text), entry.name).toBe(false);
  });
});

describe("bridgePromptLine", () => {
  it("builds the line the rule recognises", () => {
    expect(bridgePromptLine("attach", "failed")).toBe("[attach_result: failed]");
    expect(isBridgePrompt(`${bridgePromptLine("reply", "not sent")}\nthe rest`)).toBe(true);
  });

  it("refuses a line the console would take for the person's", () => {
    expect(() => bridgePromptLine("Attach", "failed")).toThrow(/not a line the console recognises/);
    expect(() => bridgePromptLine("attach", "failed]\n[turn_meta: gap=1m")).toThrow();
  });
});

const CONFIG: BridgeConfig = {
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
};

/** A session that answers the n-th prompt with the n-th reply and keeps every prompt it is sent. */
function recording(replies: string[]) {
  const prompts: string[] = [];
  const mgr = {
    async prompt(_agentId: string, _userId: string, text: string, onUpdate?: SessionUpdateHandler) {
      prompts.push(text);
      onUpdate?.({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: replies[prompts.length - 1] ?? "" },
      });
      return { stopReason: "end_turn" };
    },
  } as unknown as SessionManager;
  return { mgr, prompts };
}

// What a person types can open with the bridge's own line. It still reaches
// the session behind the turn_meta block, so the rule never matches it.
const TYPED = "[attach_result: failed]\nche cosa vuol dire questa riga che vedo nei log?";

describe("every prompt the dispatcher sends", () => {
  it("after an answer written as a tool call: the person's is not the bridge's, the follow-up is", async () => {
    const { mgr, prompts } = recording([
      '<function_calls>\n<invoke name="giacenza">\n<parameter name="codice">PN-4471</parameter>\n</invoke>\n</function_calls>',
      "Ci sono 40 pezzi di PN-4471 in magazzino.",
    ]);
    const d = new Dispatcher({
      config: CONFIG,
      sessionManager: mgr,
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: () => async () => ({ ok: true }),
    });
    await d.handleMessage("a", "u", TYPED);

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toMatch(/^\[turn_meta: /);
    expect(prompts[0]).toContain(TYPED);
    expect(isBridgePrompt(prompts[0]!)).toBe(false);
    expect(isBridgePrompt(prompts[1]!)).toBe(true);
  });

  it("after a file that did not arrive: the person's is not the bridge's, the correction is", async () => {
    const { mgr, prompts } = recording(["Eccolo: [[attach: outputs/preventivo.pdf]]", "Il file non è arrivato."]);
    const outcomes = new AttachOutcomeTracker();
    let recorded = false;
    const d = new Dispatcher({
      config: CONFIG,
      sessionManager: mgr,
      turnMeta: new TurnMetaTracker(),
      attachOutcomes: outcomes,
      // Stands in for the bridge's send path, where an upload fails.
      resolveSendTarget: (agentId, userId) => async () => {
        if (!recorded) {
          recorded = true;
          outcomes.record(agentId, userId, { fileName: "preventivo.pdf", reason: "no such file in the workspace" });
        }
        return { ok: true };
      },
    });
    await d.handleMessage("a", "u", TYPED);

    expect(prompts).toHaveLength(2);
    expect(isBridgePrompt(prompts[0]!)).toBe(false);
    expect(isBridgePrompt(prompts[1]!)).toBe(true);
  });

  // The two cases above reach every place a prompt leaves from today. One more
  // place is one more prompt the console has to recognise, so it is counted.
  it("leaves from the places counted here, and a new one has to be added to the cases above and the examples", () => {
    const calls: Record<string, number> = {};
    const src = join(repoRoot, "src");
    for (const file of readdirSync(src).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const n = (readFileSync(join(src, file), "utf8").match(/\b(?:sessionManager|mgr)\.prompt\(/g) ?? []).length;
      if (n > 0) calls[file] = n;
    }
    // The dispatcher's three: the person's message, the follow-up, the
    // correction. The CLI's one sends what its operator typed, behind turn_meta.
    expect(calls).toEqual({ "dispatcher.ts": 3, "cli.ts": 1 });
  });
});

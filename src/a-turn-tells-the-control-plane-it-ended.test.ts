// A turn's end is what lets the control-plane send the person one approval
// link for every action the assistant asked during it. These tests pin that
// the dispatcher reports the end of every turn it runs, a failed one included,
// and that a control-plane which cannot hear it changes nothing the person
// sees and does not hold up the next turn.

import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import type { SessionManager, SessionUpdateHandler } from "./session-manager.js";
import { TurnMetaTracker } from "./turn-meta.js";

function makeConfig(): BridgeConfig {
  const agent = (id: string, user: string) => ({
    id,
    channel: "discord" as const,
    cwd: "/home/agent/cerase/workspace",
    mode: "cerase",
    bot_token: "irrelevant",
    allowed_users: [user],
    spawn: { command: "env", args: ["--", "FAKE_REPLY=unused", "node", "src/__tests__/fake-acp-child.mjs"] },
  });
  return {
    agents: [agent("doc-qa", "111"), agent("policy-qa", "222")],
    session: { idle_timeout_minutes: 60, max_concurrent: 16 },
  };
}

type TurnEnded = (agentId: string, userId: string) => Promise<void>;

function harness(opts: { failAgent?: boolean; turnEnded?: TurnEnded } = {}) {
  const sent: string[] = [];
  const prompts: Array<{ agentId: string; userId: string }> = [];
  const ended: Array<{ agentId: string; userId: string }> = [];
  const turnEnded: TurnEnded =
    opts.turnEnded ??
    (async (agentId, userId) => {
      ended.push({ agentId, userId });
    });
  const d = new Dispatcher({
    config: makeConfig(),
    sessionManager: {
      async prompt(agentId: string, userId: string, _text: string, onUpdate?: SessionUpdateHandler) {
        prompts.push({ agentId, userId });
        if (opts.failAgent) throw new Error("the agent crashed");
        onUpdate?.({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "ciao" },
        } as Parameters<SessionUpdateHandler>[0]);
        return { stopReason: "end_turn" };
      },
    } as unknown as SessionManager,
    turnMeta: new TurnMetaTracker(),
    turnEnded,
    resolveSendTarget: () => async (text) => {
      sent.push(text);
      return { ok: true };
    },
  });
  return { d, sent, prompts, ended };
}

describe("a turn tells the control-plane it ended", () => {
  it("reports a completed turn once, with its agent and user", async () => {
    const h = harness();

    await expect(h.d.handleMessage("doc-qa", "111", "ping")).resolves.toEqual({ ok: true });

    await vi.waitFor(() => expect(h.ended).toEqual([{ agentId: "doc-qa", userId: "111" }]));
    expect(h.sent.join("")).toContain("ciao");
  });

  it("reports a turn whose agent call threw, once", async () => {
    const h = harness({ failAgent: true });

    const result = await h.d.handleMessage("doc-qa", "111", "ciao, come va?");

    expect(result.ok).toBe(false);
    await vi.waitFor(() => expect(h.ended).toEqual([{ agentId: "doc-qa", userId: "111" }]));
  });

  it("a control-plane that cannot hear it leaves the answer delivered and the next turn running", async () => {
    const ended = vi.fn(async (_agentId: string, _userId: string) => {
      throw new Error("control-plane down");
    });
    const h = harness({ turnEnded: ended });

    await expect(h.d.handleMessage("doc-qa", "111", "primo")).resolves.toEqual({ ok: true });
    expect(h.sent.join("")).toContain("ciao");

    await expect(h.d.handleMessage("doc-qa", "111", "secondo")).resolves.toEqual({ ok: true });
    expect(h.prompts).toHaveLength(2);
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(2));
  });

  it("reports two consecutive turns twice, each with its own agent and user", async () => {
    const h = harness();

    await h.d.handleMessage("doc-qa", "111", "uno");
    await h.d.handleMessage("policy-qa", "222", "due");

    await vi.waitFor(() => expect(h.ended).toHaveLength(2));
    expect(h.ended).toEqual(
      expect.arrayContaining([
        { agentId: "doc-qa", userId: "111" },
        { agentId: "policy-qa", userId: "222" },
      ]),
    );
  });
});

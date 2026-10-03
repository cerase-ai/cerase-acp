// A session that grows past what the runtime can summarise refuses every later
// turn: opencode checks its compaction trigger after each step, the summary
// call carries the whole history, and when that call fails as too large the
// turn ends in an error that comes back on the next turn and the one after.
// Resuming the session after a restart brings the refusal back with it.
//
// What the bridge does instead: it lets that session go, sends the message
// once more to a new session that starts from the assistant's last summary,
// and tells the person the conversation started over. Once, and never again.
//
// The fixture child plays the slot. FAKE_OUTGROWN_FILE lists the sessions it
// refuses, with the error opencode 1.18.18 sends for that case.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isBridgePrompt } from "./bridge-prompt.js";
import type { BridgeConfig } from "./config.js";
import { Dispatcher, pickErrorMessage } from "./dispatcher.js";
import { startedOverNotice } from "./platform-notices.js";
import { isCompactionOverflow, SessionManager, SessionOutgrownError, SessionRestartError } from "./session-manager.js";
import { fetchSessionSummary, type LastSummary, startedOverNote } from "./session-summary.js";
import { TurnMetaTracker } from "./turn-meta.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

// Italian enough for the language detector, so the notice is the Italian one.
const MESSAGE = "Ciao, mi prepari il riassunto della presentazione che ti ho mandato questa mattina?";
const SUMMARY: LastSummary = {
  text: "Paolo is preparing the third-quarter offer for Rossi and wants it shorter than last year's.",
  at: "2026-10-02T23:10:00+02:00",
};

// What opencode 1.18.18 sends, field for field, as the SDK hands it on.
const REFUSAL_MESSAGE =
  "Internal error: Session too large to compact - context exceeds model limit even after stripping media";
const REFUSAL_DATA = { service: "session", errorName: "ContextOverflowError" };

let dir: string;
let outgrownFile: string;
let mgr: SessionManager | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "session-outgrown-"));
  outgrownFile = join(dir, "outgrown");
});

afterEach(async () => {
  if (mgr) await mgr.shutdown();
  mgr = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function config(env: string[] = []): BridgeConfig {
  return {
    agents: [
      {
        id: "doc-qa",
        channel: "discord",
        cwd: "/home/agent/cerase/workspace",
        mode: "cerase",
        bot_token: "irrelevant",
        allowed_users: ["111"],
        spawn: {
          command: "env",
          args: [
            "--",
            ...env,
            "FAKE_ECHO_PROMPT=blocks",
            // The real slot resumes sessions. A bridge that kept the outgrown
            // id would load it back, and the fixture would refuse it again.
            "FAKE_LOAD_SESSION=1",
            `FAKE_OUTGROWN_FILE=${outgrownFile}`,
            "node",
            FAKE_CHILD,
          ],
        },
      },
    ],
    session: { idle_timeout_minutes: 60, max_concurrent: 16 },
  };
}

function manager(env: string[] = []): SessionManager {
  mgr = new SessionManager(config(env), undefined, { slotRestarted: async () => false });
  return mgr;
}

/** Mark the session the pair is talking through as one the runtime cannot summarise. */
function outgrow(m: SessionManager): string {
  const id = m.currentSessionId("doc-qa", "111");
  if (!id) throw new Error("no session to outgrow");
  writeFileSync(outgrownFile, `${id}\n`);
  return id;
}

/**
 * A dispatcher on a real session manager, with what it was sent, how often it
 * read the summary, and how many turns the agent counted while it did.
 */
function bridge(lastSummary?: () => Promise<LastSummary | undefined>, env: string[] = []) {
  const m = manager(env);
  const sent: string[] = [];
  const inFlightWhileReading: number[] = [];
  const d = new Dispatcher({
    config: config(env),
    sessionManager: m,
    turnMeta: new TurnMetaTracker(),
    resolveSendTarget: () => async (text) => {
      sent.push(text);
      return { ok: true };
    },
    lastSummary: lastSummary
      ? async () => {
          inFlightWhileReading.push(m.turnsInFlight("doc-qa"));
          return lastSummary();
        }
      : undefined,
  });
  return { d, m, sent, reads: () => inFlightWhileReading.length, inFlightWhileReading };
}

const joined = (sent: string[]) => sent.map((s) => s.replace(/ ⏎$/u, "")).join("");

describe("recognising the refusal", () => {
  it("matches what opencode sends when the summary call is too large, in both of its wordings", () => {
    expect(isCompactionOverflow(new acp.RequestError(-32603, REFUSAL_MESSAGE, REFUSAL_DATA))).toBe(true);
    expect(
      isCompactionOverflow(
        new acp.RequestError(
          -32603,
          "Internal error: Conversation history too large to compact - exceeds model context limit",
          REFUSAL_DATA,
        ),
      ),
    ).toBe(true);
  });

  it("matches nothing looser: the error name and the words are both required, on the runtime's error", () => {
    // The words without the runtime's error name.
    expect(isCompactionOverflow(new acp.RequestError(-32603, REFUSAL_MESSAGE))).toBe(false);
    expect(
      isCompactionOverflow(new acp.RequestError(-32603, REFUSAL_MESSAGE, { ...REFUSAL_DATA, errorName: "APIError" })),
    ).toBe(false);
    // The error name on another overflow.
    expect(isCompactionOverflow(new acp.RequestError(-32603, "Internal error: prompt is too long", REFUSAL_DATA))).toBe(
      false,
    );
    // The same text written by anything but the runtime: a model's answer, a
    // log line quoted back.
    expect(isCompactionOverflow(new Error(REFUSAL_MESSAGE))).toBe(false);
    expect(isCompactionOverflow(REFUSAL_MESSAGE)).toBe(false);
  });
});

describe("a session the runtime cannot summarise", () => {
  it("is let go: the next prompt starts a new session instead of being refused again", async () => {
    const m = manager();
    await m.prompt("doc-qa", "111", "first");
    const before = outgrow(m);

    const err = await m.prompt("doc-qa", "111", "second").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionOutgrownError);
    expect((err as SessionOutgrownError).sessionId).toBe(before);

    const chunks: string[] = [];
    await m.prompt("doc-qa", "111", "third", (u) => {
      if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") chunks.push(u.content.text);
    });
    expect(m.currentSessionId("doc-qa", "111")).not.toBe(before);
    expect(chunks.join("")).toBe("everyone: third");
  });

  it("is not kept for a resume, so a restart does not bring it back", async () => {
    const m = manager();
    await m.prompt("doc-qa", "111", "first");
    const before = outgrow(m);
    await m.prompt("doc-qa", "111", "second").catch(() => undefined);
    // What the console's restart and a reload do: end the pair's sessions,
    // whose ids are then kept and loaded by the next prompt.
    m.killAgentSessions("doc-qa");
    await new Promise((r) => setTimeout(r, 300));
    expect(m.resumableSessionCount()).toBe(0);

    await m.prompt("doc-qa", "111", "third");
    expect(m.currentSessionId("doc-qa", "111")).not.toBe(before);
  });

  it("hands a turn queued behind the refused one to the session that replaces it", async () => {
    const m = manager();
    await m.prompt("doc-qa", "111", "first");
    outgrow(m);
    const [refused, queued] = await Promise.all([
      m.prompt("doc-qa", "111", "second").catch((e: unknown) => e),
      m.prompt("doc-qa", "111", "third").catch((e: unknown) => e),
    ]);
    expect(refused).toBeInstanceOf(SessionOutgrownError);
    // Never sent to the session that was let go: it is held and sent again,
    // as a turn held through a restart is.
    expect(queued).toBeInstanceOf(SessionRestartError);
    expect((queued as SessionRestartError).reachedAgent).toBe(false);
  });

  it("keeps any other refusal as the turn's failure, on the same session", async () => {
    const m = manager(["FAKE_OUTGROWN_ERROR_NAME=APIError"]);
    await m.prompt("doc-qa", "111", "first");
    const before = outgrow(m);

    const err = await m.prompt("doc-qa", "111", "second").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(acp.RequestError);
    expect(err).not.toBeInstanceOf(SessionOutgrownError);
    expect(m.currentSessionId("doc-qa", "111")).toBe(before);
  });
});

describe("a prompt with text for the assistant alone", () => {
  it("sends it ahead of the person's, addressed to the assistant", async () => {
    const m = manager();
    const chunks: string[] = [];
    await m.prompt(
      "doc-qa",
      "111",
      "the person's words",
      (u) => {
        if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") chunks.push(u.content.text);
      },
      { context: "for the assistant" },
    );
    expect(chunks.join("")).toBe("assistant: for the assistant\n\neveryone: the person's words");
  });
});

describe("a message whose session outgrew its summary", () => {
  it("is answered by a new session that starts from the last summary, after the person is told", async () => {
    const { d, m, sent, inFlightWhileReading } = bridge(async () => SUMMARY);
    await d.handleMessage("doc-qa", "111", "Ciao, come stai oggi? Mi aiuti con una cosa?");
    const before = outgrow(m);
    sent.length = 0;

    const result = await d.handleMessage("doc-qa", "111", MESSAGE);

    expect(result).toEqual({ ok: true });
    // Read once, while the agent still counted the turn: a control-plane that
    // read it as idle then would restart the slot under it.
    expect(inFlightWhileReading).toEqual([1]);
    expect(m.currentSessionId("doc-qa", "111")).not.toBe(before);
    // The person reads that the conversation started over, before the answer.
    const notice = startedOverNotice("it", true);
    expect(sent[0]).toBe(notice);
    const answer = joined(sent.slice(1));
    expect(answer).not.toContain(pickErrorMessage(MESSAGE));
    // The new session was told, for the assistant alone, that it starts over
    // and from what, and then received the person's message as they wrote it.
    expect(answer).toMatch(/^assistant: \[session_result: started over\]\n\n/);
    expect(answer).toContain(SUMMARY.text);
    expect(answer).toContain(`written ${SUMMARY.at}`);
    expect(answer).toMatch(/\n\neveryone: \[turn_meta: [^\]]*\]\n\nCiao, mi prepari il riassunto/);
  });

  it("starts over without a summary when there is none, or none can be read, and says so", async () => {
    for (const lastSummary of [async () => undefined, async () => Promise.reject(new Error("HTTP 404"))]) {
      const { d, m, sent } = bridge(lastSummary);
      await d.handleMessage("doc-qa", "111", "Ciao, come stai oggi? Mi aiuti con una cosa?");
      outgrow(m);
      sent.length = 0;

      const result = await d.handleMessage("doc-qa", "111", MESSAGE);

      expect(result).toEqual({ ok: true });
      expect(sent[0]).toBe(startedOverNotice("it", false));
      const answer = joined(sent.slice(1));
      expect(answer).toContain("No summary of the previous conversation exists.");
      expect(answer).toContain(MESSAGE);
      await m.shutdown();
    }
  });

  it("is sent once more and never again: a new session refused too ends the turn with the usual failure", async () => {
    const { d, sent, reads } = bridge(async () => SUMMARY);
    writeFileSync(outgrownFile, "*\n");

    const result = await d.handleMessage("doc-qa", "111", MESSAGE);

    expect(result.ok).toBe(false);
    expect(reads()).toBe(1);
    expect(sent).toEqual([startedOverNotice("it", true), pickErrorMessage(MESSAGE)]);
  });

  it("is not started over for any other failure", async () => {
    const { d, m, sent, reads } = bridge(async () => SUMMARY, ["FAKE_OUTGROWN_ERROR_NAME=APIError"]);
    await d.handleMessage("doc-qa", "111", "Ciao, come stai oggi? Mi aiuti con una cosa?");
    outgrow(m);
    sent.length = 0;

    const result = await d.handleMessage("doc-qa", "111", MESSAGE);

    expect(result.ok).toBe(false);
    expect(reads()).toBe(0);
    expect(sent).toEqual([pickErrorMessage(MESSAGE)]);
  });
});

describe("what the new session is told", () => {
  it("opens with the bridge's own line, so a console reading the message back whole never shows it as the person's", () => {
    expect(isBridgePrompt(startedOverNote(SUMMARY))).toBe(true);
    expect(isBridgePrompt(startedOverNote(undefined))).toBe(true);
  });

  it("is one line per paragraph", () => {
    for (const note of [startedOverNote({ text: "one line" }), startedOverNote(undefined)]) {
      for (const paragraph of note.split("\n\n")) expect(paragraph).not.toContain("\n");
    }
  });
});

describe("the notice the person reads", () => {
  it("is in the person's language, says whether the new conversation starts from a summary, and falls back to Italian", () => {
    for (const fromSummary of [true, false]) {
      const texts = (["it", "en", "es", "fr"] as const).map((lang) => startedOverNotice(lang, fromSummary));
      expect(new Set(texts).size).toBe(4);
      expect(startedOverNotice("unknown", fromSummary)).toBe(startedOverNotice("it", fromSummary));
      for (const text of texts) expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    }
    expect(startedOverNotice("en", true)).toContain("from a summary");
    expect(startedOverNotice("en", false)).toContain("no summary");
  });
});

describe("reading the last summary from the control-plane", () => {
  it("GETs it by the bridge's agent id with the internal bearer", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const got = await fetchSessionSummary("agent-1", {
      controlPlaneUrl: "http://cp:8000/",
      internalSecret: "s3cret",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url, auth: new Headers(init?.headers).get("Authorization") });
        return new Response(JSON.stringify({ summary: `  ${SUMMARY.text}  `, summarised_at: SUMMARY.at }));
      }) as typeof fetch,
    });
    expect(calls).toEqual([{ url: "http://cp:8000/api/internal/session-summary/agent-1", auth: "Bearer s3cret" }]);
    expect(got).toEqual(SUMMARY);
  });

  it("answers none for an assistant with no summary, and throws on a refusal", async () => {
    const answering = (status: number, body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const opts = { controlPlaneUrl: "http://cp", internalSecret: "s" };
    expect(
      await fetchSessionSummary("agent-1", {
        ...opts,
        fetchImpl: answering(200, { summary: null, summarised_at: null }),
      }),
    ).toBeUndefined();
    await expect(
      fetchSessionSummary("agent-1", { ...opts, fetchImpl: answering(404, { message: "Not Found" }) }),
    ).rejects.toThrow(/HTTP 404/);
  });
});

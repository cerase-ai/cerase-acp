import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultEndpointForAgent,
  execFetcher,
  execOpenCallProbe,
  execSessionMessages,
  SLOT_REST_SCRIPT,
  type SlotExec,
  unansweredAfterSummaryOf,
} from "./opencode-rest.js";

// The bridge reads a slot's canonical message from INSIDE the slot. It used to
// fetch http://cerase-agent-N:3284 over a network it shared with every slot,
// and that network was also how a slot reached the bridge's :7476 and every
// other slot's :3284. The slot's server now listens on loopback, so a fetch
// that went back to the network would reach nothing.

function recording(stdout: string, ok = true): { exec: SlotExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: SlotExec = async (args) => {
    calls.push(args);
    return { stdout, ok };
  };
  return { exec, calls };
}

// A slot that answers `GET /session/{id}/message?limit=N` with the last N
// messages of a stored list, oldest first, the way opencode does.
function answeringByLimit(messages: unknown[]): { exec: SlotExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: SlotExec = async (args) => {
    calls.push(args);
    const limit = Number(/limit=(\d+)/.exec(args.at(-1) ?? "")?.[1] ?? messages.length);
    return { stdout: `${JSON.stringify(messages.slice(-limit))}\n200`, ok: true };
  };
  return { exec, calls };
}

const message = JSON.stringify({
  info: { id: "msg_1" },
  parts: [{ id: "prt_0", type: "text", text: "whole reply" }],
});

describe("execFetcher", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the slot's own loopback through docker exec, and never the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { exec, calls } = recording(`${message}\n200`);

    const got = await execFetcher(exec)({ containerName: "cerase-agent-3" }, "ses_a", "msg_1");

    expect(got).toEqual({ id: "msg_1", parts: [{ id: "prt_0", type: "text", text: "whole reply", ignored: false }] });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toEqual([
      ["exec", "cerase-agent-3", "sh", "-c", SLOT_REST_SCRIPT, "sh", "/session/ses_a/message/msg_1"],
    ]);
    expect(SLOT_REST_SCRIPT).toContain("http://127.0.0.1:3284$1");
  });

  it("resolves the password inside the slot, file first, the way the slot binds it", () => {
    const file = SLOT_REST_SCRIPT.indexOf("/etc/opencode/server-password");
    const env = SLOT_REST_SCRIPT.indexOf("$OPENCODE_SERVER_PASSWORD");
    expect(file).toBeGreaterThanOrEqual(0);
    expect(env).toBeGreaterThan(file);
  });

  it("runs in a real shell: curl gets the loopback URL, the shared password and a status line", () => {
    const bin = mkdtempSync(join(tmpdir(), "acp-slot-curl-"));
    writeFileSync(join(bin, "curl"), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n');
    chmodSync(join(bin, "curl"), 0o755);
    const out = execFileSync("sh", ["-c", SLOT_REST_SCRIPT, "sh", "/session/s/message/m"], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, OPENCODE_SERVER_PASSWORD: "shared-pw" },
    }).split("\n");
    expect(out).toContain("opencode:shared-pw");
    expect(out).toContain("http://127.0.0.1:3284/session/s/message/m");
    expect(out[out.indexOf("-w") + 1]).toBe("\\n%{http_code}");
  });

  it("passes the session and message ids as an argument, never as script", async () => {
    const { exec, calls } = recording(`${message}\n200`);

    await execFetcher(exec)({ containerName: "cerase-agent-3" }, "ses_$(id)", "msg_1;x");

    expect(calls[0]?.[4]).toBe(SLOT_REST_SCRIPT);
    expect(calls[0]?.[6]).toBe("/session/ses_%24(id)/message/msg_1%3Bx");
  });

  it("reads a 404 as nothing to reconcile", async () => {
    const { exec } = recording('{"name":"NotFound"}\n404');
    expect(await execFetcher(exec)({ containerName: "cerase-agent-3" }, "ses_a", "msg_1")).toBeNull();
  });

  it("degrades to null on a non-2xx, a failed exec and a body that is not JSON", async () => {
    expect(await execFetcher(recording("denied\n401").exec)({ containerName: "cerase-agent-3" }, "s", "m")).toBeNull();
    expect(await execFetcher(recording("", false).exec)({ containerName: "cerase-agent-3" }, "s", "m")).toBeNull();
    expect(await execFetcher(recording("<html>\n200").exec)({ containerName: "cerase-agent-3" }, "s", "m")).toBeNull();
  });
});

// opencode writes a session's summary as an assistant message of its own,
// flagged `summary: true`, and stamps `time.completed` on it when the call
// ends. An answer is also an assistant message, and over ACP nothing says
// either call started, so the newest message of the session is what the
// watchdog asks about.
describe("execOpenCallProbe", () => {
  const newest = (info: Record<string, unknown>, parts: unknown[] = []) => `${JSON.stringify([{ info, parts }])}\n200`;
  const summary = {
    id: "msg_sum",
    role: "assistant",
    mode: "compaction",
    agent: "compaction",
    summary: true,
    time: { created: 1 },
  };
  const answer = {
    id: "msg_ans",
    role: "assistant",
    mode: "cerase",
    agent: "cerase",
    time: { created: 1 },
  };

  it("reports an open summary and asks the slot for the session's newest message, the session id as an argument", async () => {
    const { exec, calls } = recording(newest(summary));
    expect(await execOpenCallProbe(exec)("cerase-agent-3", "ses_$(id)")).toEqual({
      messageId: "msg_sum",
      summary: true,
    });
    expect(calls).toEqual([
      ["exec", "cerase-agent-3", "sh", "-c", SLOT_REST_SCRIPT, "sh", "/session/ses_%24(id)/message?limit=1"],
    ]);
  });

  it("reports an open answer as a model call, not a summary", async () => {
    const { exec } = recording(newest(answer));
    expect(await execOpenCallProbe(exec)("cerase-agent-3", "ses_a")).toEqual({
      messageId: "msg_ans",
      summary: false,
    });
  });

  it("finds no open model call in a finished summary, a finished answer, an aborted answer, a person's message, or an empty list", async () => {
    const probe = (stdout: string) => execOpenCallProbe(recording(stdout).exec)("cerase-agent-3", "ses_a");
    expect(await probe(newest({ ...summary, time: { created: 1, completed: 2 } }))).toBeNull();
    expect(await probe(newest({ ...answer, time: { created: 1, completed: 2 } }))).toBeNull();
    expect(await probe(newest({ ...answer, error: { name: "MessageAbortedError" } }))).toBeNull();
    expect(
      await probe(newest({ id: "msg_u", role: "user", time: { created: 1 } }, [{ type: "compaction", auto: true }])),
    ).toBeNull();
    expect(await probe("[]\n200")).toBeNull();
  });

  it("answers null when the slot cannot say", async () => {
    const probe = (stdout: string, ok = true) =>
      execOpenCallProbe(recording(stdout, ok).exec)("cerase-agent-3", "ses_a");
    expect(await probe('{"name":"NotFound"}\n404')).toBeNull();
    expect(await probe("denied\n401")).toBeNull();
    expect(await probe("", false)).toBeNull();
    expect(await probe("<html>\n200")).toBeNull();
  });

  // opencode appends the person's messages to the session's history as they
  // arrive, so the newest entry can be the person's even while a model call
  // started earlier is still open. The call is the newest assistant message,
  // and the person's messages after it do not close it.
  const marker = { id: "msg_marker", role: "user", time: { created: 0 } };
  const summaryMarker = { info: marker, parts: [{ id: "prt_marker", type: "compaction", auto: true }] };
  const personMessage = (id: string, created: number) => ({
    info: { id, role: "user", time: { created } },
    parts: [{ id: `prt_${id}`, type: "text", text: "a message written while the call is open" }],
  });

  it("still reports the open summary when the person's messages were written after it", async () => {
    const { exec } = answeringByLimit([
      summaryMarker,
      { info: summary, parts: [] },
      personMessage("msg_person_1", 3),
      personMessage("msg_person_2", 4),
    ]);

    expect(await execOpenCallProbe(exec)("cerase-agent-1", "ses_a")).toEqual({
      messageId: "msg_sum",
      summary: true,
    });
  });

  it("still reports an open answer when a person's message was written after it", async () => {
    const { exec } = answeringByLimit([summaryMarker, { info: answer, parts: [] }, personMessage("msg_person_1", 3)]);

    expect(await execOpenCallProbe(exec)("cerase-agent-1", "ses_a")).toEqual({
      messageId: "msg_ans",
      summary: false,
    });
  });

  it("finds no open call when the person's message follows a finished answer", async () => {
    const { exec } = answeringByLimit([
      { info: { ...answer, time: { created: 1, completed: 2 } }, parts: [] },
      personMessage("msg_person_1", 3),
    ]);

    expect(await execOpenCallProbe(exec)("cerase-agent-1", "ses_a")).toBeNull();
  });

  it("reads only the newest message when that message is the assistant's", async () => {
    const { exec, calls } = answeringByLimit([
      summaryMarker,
      personMessage("msg_person_1", 2),
      { info: summary, parts: [] },
    ]);

    expect(await execOpenCallProbe(exec)("cerase-agent-1", "ses_a")).toEqual({
      messageId: "msg_sum",
      summary: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.at(-1)).toBe("/session/ses_a/message?limit=1");
  });
});

describe("unansweredAfterSummaryOf", () => {
  const answer = (id: string) => ({ info: { id, role: "assistant" }, parts: [] });
  const summary = (info: Record<string, unknown> = {}) => ({
    info: { id: "msg_sum", role: "assistant", summary: true, ...info },
    parts: [],
  });
  const person = (id: string, text: string, parts: unknown[] = []) => ({
    info: { id, role: "user" },
    parts: [{ type: "text", text }, ...parts],
  });

  it("returns nothing when the newest assistant message is an answer", () => {
    expect(unansweredAfterSummaryOf([person("msg_1", "first"), answer("msg_a")])).toEqual([]);
  });

  it("returns nothing when there is no assistant message", () => {
    expect(unansweredAfterSummaryOf([person("msg_1", "first")])).toEqual([]);
  });

  it("returns the person's messages after the last answer, oldest first, with their text", () => {
    const messages = [
      person("msg_1", "first"),
      answer("msg_a"),
      person("msg_2", "second"),
      person("msg_3", "third"),
      summary(),
    ];
    expect(unansweredAfterSummaryOf(messages)).toEqual([
      { id: "msg_2", text: "second" },
      { id: "msg_3", text: "third" },
    ]);
  });

  it("skips a compaction marker and a synthetic-only message, and leaves a synthetic part out of the text", () => {
    const messages = [
      person("msg_1", "first"),
      answer("msg_a"),
      { info: { id: "msg_marker", role: "user" }, parts: [{ type: "compaction", auto: true }] },
      { info: { id: "msg_synthetic", role: "user" }, parts: [{ type: "text", text: "internal", synthetic: true }] },
      {
        info: { id: "msg_2", role: "user" },
        parts: [
          { type: "text", text: "internal", synthetic: true },
          { type: "text", text: "second" },
        ],
      },
      summary(),
    ];
    expect(unansweredAfterSummaryOf(messages)).toEqual([{ id: "msg_2", text: "second" }]);
  });

  it("does not list a message followed by an answer and then a summary", () => {
    const messages = [person("msg_1", "first"), answer("msg_a"), person("msg_2", "second"), answer("msg_b"), summary()];
    expect(unansweredAfterSummaryOf(messages)).toEqual([]);
  });

  it("recognises each of the three summary signals", () => {
    for (const info of [
      { id: "msg_sum", role: "assistant", summary: true },
      { id: "msg_sum", role: "assistant", mode: "compaction" },
      { id: "msg_sum", role: "assistant", agent: "compaction" },
    ]) {
      const messages = [person("msg_1", "first"), answer("msg_a"), person("msg_2", "second"), { info, parts: [] }];
      expect(unansweredAfterSummaryOf(messages)).toEqual([{ id: "msg_2", text: "second" }]);
    }
  });

  it("returns nothing when the messages are not an array, and ignores non-object entries", () => {
    expect(unansweredAfterSummaryOf(null)).toEqual([]);
    expect(unansweredAfterSummaryOf({ messages: [] })).toEqual([]);
    expect(unansweredAfterSummaryOf([null, "a string", 4, summary()])).toEqual([]);
  });
});

describe("execSessionMessages", () => {
  it("asks for the limit on the encoded session id and returns the messages", async () => {
    const messages = [
      { info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "first" }] },
      { info: { id: "msg_sum", role: "assistant", summary: true }, parts: [] },
    ];
    const { exec, calls } = answeringByLimit(messages);

    expect(await execSessionMessages(exec)("cerase-agent-3", "ses_$(id)", 20)).toEqual(messages);
    expect(calls).toEqual([
      ["exec", "cerase-agent-3", "sh", "-c", SLOT_REST_SCRIPT, "sh", "/session/ses_%24(id)/message?limit=20"],
    ]);
  });
});

describe("defaultEndpointForAgent", () => {
  it("names the slot and carries no password", () => {
    expect(defaultEndpointForAgent("cerase-agent-7")).toEqual({ containerName: "cerase-agent-7" });
  });

  it("refuses a name docker could not have given a container", () => {
    expect(defaultEndpointForAgent("-rm")).toBeNull();
    expect(defaultEndpointForAgent("a b")).toBeNull();
    expect(defaultEndpointForAgent("")).toBeNull();
  });
});

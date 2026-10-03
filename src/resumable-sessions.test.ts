// The session each person is talking through survives a restart of the bridge,
// not only a restart of the slot. A slot restart is survived because the
// bridge keeps the id in memory; a bridge restart takes that memory with it,
// and the person's next message opened a new session with none of the
// conversation in it.
//
// Two SessionManagers on one state directory play the bridge before and after
// its restart. The first is never shut down before the second starts: a bridge
// that is stopped or killed lets no child exit first, so whatever is written
// only when a child exits is never written.

import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BridgeConfig } from "./config.js";
import { RESUMABLE_SESSIONS_FILE, ResumableSessions } from "./resumable-sessions.js";
import { SessionManager, SessionOutgrownError } from "./session-manager.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

let dir: string;
let managers: SessionManager[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "resumable-sessions-"));
});

afterEach(async () => {
  await Promise.all(managers.map((m) => m.shutdown()));
  managers = [];
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

/** The pairs and sessions the file holds, in its order. */
function onDisk(): Array<[string, string]> {
  const parsed = JSON.parse(readFileSync(join(dir, RESUMABLE_SESSIONS_FILE), "utf8")) as {
    sessions: Array<{ pair: string; session: string }>;
  };
  return parsed.sessions.map(({ pair, session }) => [pair, session]);
}

describe("the record of resumable sessions", () => {
  it("is read back by the next instance in the order it was used, oldest first", () => {
    const before = new ResumableSessions(dir, 10);
    before.remember("a:1", "s-a");
    before.remember("b:2", "s-b");
    before.remember("a:1", "s-a2");

    const after = new ResumableSessions(dir, 10);
    expect(after.get("a:1")).toBe("s-a2");
    expect(after.get("b:2")).toBe("s-b");
    expect(onDisk()).toEqual([
      ["b:2", "s-b"],
      ["a:1", "s-a2"],
    ]);
  });

  it("holds no more pairs on disk than the bound, dropping the least recently used", () => {
    const store = new ResumableSessions(dir, 3);
    for (const n of [1, 2, 3, 4]) store.remember(`a:${n}`, `s-${n}`);
    store.remember("a:2", "s-2");
    store.remember("a:5", "s-5");

    expect(onDisk().map(([pair]) => pair)).toEqual(["a:4", "a:2", "a:5"]);
    const after = new ResumableSessions(dir, 3);
    expect(after.size).toBe(3);
    expect(after.get("a:3")).toBeUndefined();
  });

  it("applies the bound to a file written under a larger one", () => {
    const wide = new ResumableSessions(dir, 10);
    for (const n of [1, 2, 3, 4]) wide.remember(`a:${n}`, `s-${n}`);
    const narrow = new ResumableSessions(dir, 2);
    expect(narrow.size).toBe(2);
    expect(narrow.get("a:3")).toBe("s-3");
    expect(narrow.get("a:4")).toBe("s-4");
  });

  it("forgets a pair on disk, and only while it still holds the session being forgotten", () => {
    const store = new ResumableSessions(dir, 10);
    store.remember("a:1", "s-old");
    store.remember("a:1", "s-new");
    store.forget("a:1", "s-old");
    expect(new ResumableSessions(dir, 10).get("a:1")).toBe("s-new");

    store.forget("a:1", "s-new");
    expect(new ResumableSessions(dir, 10).get("a:1")).toBeUndefined();
    expect(onDisk()).toEqual([]);
  });

  it("starts empty from a file it cannot parse, and replaces it on the next write", () => {
    writeFileSync(join(dir, RESUMABLE_SESSIONS_FILE), "{ not json");
    const store = new ResumableSessions(dir, 10);
    expect(store.size).toBe(0);
    store.remember("a:1", "s-1");
    expect(onDisk()).toEqual([["a:1", "s-1"]]);
  });

  it("starts empty from a file of another shape, keeping only well-formed entries", () => {
    writeFileSync(join(dir, RESUMABLE_SESSIONS_FILE), JSON.stringify({ "a:1": "s-1" }));
    expect(new ResumableSessions(dir, 10).size).toBe(0);

    writeFileSync(
      join(dir, RESUMABLE_SESSIONS_FILE),
      JSON.stringify({ sessions: [{ pair: "a:1", session: "s-1" }, { pair: "a:2" }, null, { pair: 3, session: "x" }] }),
    );
    const store = new ResumableSessions(dir, 10);
    expect(store.size).toBe(1);
    expect(store.get("a:1")).toBe("s-1");
  });

  it("writes through a temporary file and leaves none behind", () => {
    const store = new ResumableSessions(dir, 10);
    store.remember("a:1", "s-1");
    store.remember("a:2", "s-2");
    expect(readdirSync(dir)).toEqual([RESUMABLE_SESSIONS_FILE]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "keeps the record in memory and the previous file whole when a write fails",
    () => {
      const store = new ResumableSessions(dir, 10);
      store.remember("a:1", "s-1");
      chmodSync(dir, 0o500);
      store.remember("a:2", "s-2");
      expect(store.get("a:2")).toBe("s-2");
      expect(onDisk()).toEqual([["a:1", "s-1"]]);
    },
  );

  it("writes nothing when the bridge has no state directory", () => {
    const store = new ResumableSessions(undefined, 10);
    store.remember("a:1", "s-1");
    expect(store.get("a:1")).toBe("s-1");
    expect(readdirSync(dir)).toEqual([]);
  });
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
        spawn: { command: "env", args: ["--", "FAKE_REPLY=x", "FAKE_LOAD_SESSION=1", ...env, "node", FAKE_CHILD] },
      },
    ],
    session: { idle_timeout_minutes: 60, max_concurrent: 16 },
  };
}

/** A SessionManager on the shared state directory: the bridge as one process runs it. */
function bridge(env: string[] = []): SessionManager {
  const mgr = new SessionManager(config(env), undefined, { stateDir: dir });
  managers.push(mgr);
  return mgr;
}

describe("a session across a restart of the bridge", () => {
  it("is resumed by the next bridge, though the previous one never saw its child exit", async () => {
    const before = bridge();
    await before.prompt("doc-qa", "111", "first");
    const session = before.currentSessionId("doc-qa", "111");
    expect(session).toBeDefined();

    const after = bridge();
    await after.prompt("doc-qa", "111", "second");
    expect(after.currentSessionId("doc-qa", "111")).toBe(session);
  });

  it("is on disk while the session is still running", async () => {
    const mgr = bridge();
    await mgr.prompt("doc-qa", "111", "first");
    expect(mgr.activeSessionCount()).toBe(1);
    expect(onDisk()).toEqual([["doc-qa:111", mgr.currentSessionId("doc-qa", "111")]]);
  });

  it("is not resumed by the next bridge once it was let go for outgrowing its summary", async () => {
    const outgrown = join(dir, "outgrown");
    const before = bridge([`FAKE_OUTGROWN_FILE=${outgrown}`]);
    await before.prompt("doc-qa", "111", "first");
    const session = before.currentSessionId("doc-qa", "111");
    writeFileSync(outgrown, `${session}\n`);
    await expect(before.prompt("doc-qa", "111", "second")).rejects.toBeInstanceOf(SessionOutgrownError);

    // The slot still refuses that session: loading it back fails the turn.
    const after = bridge([`FAKE_OUTGROWN_FILE=${outgrown}`]);
    await after.prompt("doc-qa", "111", "third");
    expect(after.currentSessionId("doc-qa", "111")).not.toBe(session);
  });

  it("is not tried again by the next bridge once a load of it was refused", async () => {
    const first = bridge();
    await first.prompt("doc-qa", "111", "first");
    const session = first.currentSessionId("doc-qa", "111");

    // The load is refused, and the session that would replace it is refused
    // too, so nothing is recorded after the refusal.
    const second = bridge(["FAKE_LOAD_FAILS=1", "FAKE_MODES=build"]);
    await expect(second.prompt("doc-qa", "111", "second")).rejects.toThrow();

    const third = bridge();
    await third.prompt("doc-qa", "111", "third");
    expect(third.currentSessionId("doc-qa", "111")).not.toBe(session);
  });

  it("starts the conversation over from a file it cannot read, and answers", async () => {
    writeFileSync(join(dir, RESUMABLE_SESSIONS_FILE), "\u0000garbage");
    const mgr = bridge();
    const r = await mgr.prompt("doc-qa", "111", "first");
    expect(r.stopReason).toBe("end_turn");
    expect(existsSync(join(dir, RESUMABLE_SESSIONS_FILE))).toBe(true);
    expect(onDisk()).toEqual([["doc-qa:111", mgr.currentSessionId("doc-qa", "111")]]);
  });
});

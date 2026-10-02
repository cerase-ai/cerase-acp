// A turn that meets the assistant while its slot restarts is held and sent once
// the session is back; only a session that stays away past the bound reaches
// the person, and then in words that say the assistant is restarting. A session
// that closes while the slot keeps running is a failure, and fails as before.
//
// The fixture child plays the slot: FAKE_RESTART_MID_PROMPT_FILE makes it die
// with 137 under a turn it has started, as a `docker exec` child does when the
// container restarts, and FAKE_SLOT_DOWN_FILE makes every spawn exit at once,
// as `docker exec` does against a container that is down.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig, BridgeConfig } from "./config.js";
import { Dispatcher, pickErrorMessage } from "./dispatcher.js";
import type { SlotExec } from "./opencode-rest.js";
import { restartOutlastedNotice } from "./platform-notices.js";
import { dockerSlotRestartProbe, slotContainerOf, stateRestartedSince } from "./restart-hold.js";
import { SessionManager, SessionRestartError } from "./session-manager.js";
import { TurnMetaTracker } from "./turn-meta.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

// Italian enough for the language detector, so the notices are the Italian ones.
const MESSAGE = "Ciao, mi prepari il riassunto della presentazione che ti ho mandato questa mattina?";
const SECOND = "E poi mi dici anche quali sono le prossime scadenze del progetto, per favore?";

let dir: string;
let restartFile: string;
let slotDownFile: string;
let mgr: SessionManager | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "restart-hold-"));
  restartFile = join(dir, "restart-mid-prompt");
  slotDownFile = join(dir, "slot-down");
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
            "FAKE_ECHO_PROMPT=1",
            "FAKE_LOAD_SESSION=1",
            `FAKE_RESTART_MID_PROMPT_FILE=${restartFile}`,
            `FAKE_SLOT_DOWN_FILE=${slotDownFile}`,
            "node",
            FAKE_CHILD,
          ],
        },
      },
    ],
    session: { idle_timeout_minutes: 60, max_concurrent: 16 },
  };
}

/** A dispatcher on a real session manager whose slot answers `restarted` when asked. */
function bridge(restarted: (since: number) => boolean, boundMs: number, env: string[] = []) {
  const cfg = config(env);
  const asked: number[] = [];
  mgr = new SessionManager(cfg, undefined, {
    slotRestarted: async (_agent, since) => {
      asked.push(since);
      return restarted(since);
    },
  });
  const sent: string[] = [];
  const d = new Dispatcher({
    config: cfg,
    sessionManager: mgr,
    turnMeta: new TurnMetaTracker(),
    resolveSendTarget: () => async (text) => {
      sent.push(text);
      return { ok: true };
    },
    restartHold: { boundMs, retryMs: 50 },
  });
  return { d, sent, asked, mgr };
}

const joined = (sent: string[]) => sent.map((s) => s.replace(/ ⏎$/u, "")).join("");

/** A slot that says it restarted, and is back `ms` after it is first asked. */
function backAfter(ms: number): () => boolean {
  let asked = false;
  return () => {
    if (!asked) {
      asked = true;
      setTimeout(() => rmSync(slotDownFile, { force: true }), ms);
    }
    return true;
  };
}

describe("a turn that meets a slot restart", () => {
  it("is held while the slot is down and answered once the session is back", async () => {
    // The slot restarts under the turn and stays down for a while, as a slot
    // restart does: the turn is cut off, then every spawn is refused, then one
    // is not.
    writeFileSync(restartFile, "");
    const { d, sent, asked } = bridge(backAfter(400), 10_000);

    const result = await d.handleMessage("doc-qa", "111", MESSAGE);

    expect(result).toEqual({ ok: true });
    // The answer is the one the session gave once it was back: the fixture
    // echoes the prompt it was sent, which is the person's message.
    const answer = joined(sent);
    expect(answer).toMatch(/^\[turn_meta: /);
    expect(answer).toContain(MESSAGE);
    expect(answer).not.toContain(pickErrorMessage(MESSAGE));
    expect(answer).not.toContain(restartOutlastedNotice("it"));
    // Asked once for the turn that was cut off and at least once for a spawn
    // refused while the slot was down.
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(existsSync(restartFile)).toBe(false);
  });

  it("drops what the cut-off try had not sent yet, so the answer reaches the person once", async () => {
    writeFileSync(restartFile, "");
    const cut = "Sto aprendo la presentazione";
    const { d, sent } = bridge(backAfter(200), 10_000, [`FAKE_RESTART_SAYS=${cut}`]);

    const result = await d.handleMessage("doc-qa", "111", MESSAGE);

    expect(result).toEqual({ ok: true });
    expect(joined(sent)).not.toContain(cut);
    expect(joined(sent)).toContain(MESSAGE);
  });

  it("tells the person, past the bound, that the assistant is restarting, and only then", async () => {
    writeFileSync(slotDownFile, "");
    const boundMs = 400;
    const { d, sent, mgr: m } = bridge(() => true, boundMs);

    const started = Date.now();
    const turn = d.handleMessage("doc-qa", "111", MESSAGE);
    // While it waits, the turn is outstanding: the control-plane reads this
    // before it restarts the slot again.
    await new Promise((r) => setTimeout(r, 150));
    expect(sent).toEqual([]);
    expect(m.turnsInFlight("doc-qa")).toBe(1);
    const result = await turn;

    expect(Date.now() - started).toBeGreaterThanOrEqual(boundMs);
    expect(result.ok).toBe(false);
    expect(sent).toEqual([restartOutlastedNotice("it")]);
    expect(m.turnsInFlight("doc-qa")).toBe(0);
  });

  it("answers a message sent during the hold after the one being held", async () => {
    writeFileSync(slotDownFile, "");
    const { d, sent } = bridge(() => true, 10_000);

    const first = d.handleMessage("doc-qa", "111", MESSAGE);
    await new Promise((r) => setTimeout(r, 120));
    const second = d.handleMessage("doc-qa", "111", SECOND);
    await new Promise((r) => setTimeout(r, 120));
    rmSync(slotDownFile);

    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    const answer = joined(sent);
    expect(answer.indexOf(MESSAGE)).toBeGreaterThanOrEqual(0);
    expect(answer.indexOf(SECOND)).toBeGreaterThan(answer.indexOf(MESSAGE));
  });
});

describe("a session that closes while the slot keeps running", () => {
  it("fails the turn at once with the error it always had", async () => {
    writeFileSync(restartFile, "");
    const { d, sent, asked } = bridge(() => false, 10_000);

    const started = Date.now();
    const result = await d.handleMessage("doc-qa", "111", MESSAGE);

    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(sent).toEqual([pickErrorMessage(MESSAGE)]);
    expect(asked).toHaveLength(1);
  });
});

describe("a session the bridge closes itself", () => {
  it("is reported as a restart without asking the slot", async () => {
    // A child that never answers, so the turn is in flight when the session ends.
    const cfg = config(["FAKE_HANG_PROMPT=1"]);
    let asked = 0;
    mgr = new SessionManager(cfg, undefined, {
      slotRestarted: async () => {
        asked += 1;
        return false;
      },
    });
    const turn = mgr.prompt("doc-qa", "111", MESSAGE);
    await new Promise((r) => setTimeout(r, 300));
    mgr.killAgentSessions("doc-qa");

    const err = await turn.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SessionRestartError);
    expect(asked).toBe(0);
  });
});

describe("the slot probe", () => {
  const agent = (command: string, args: string[]): AgentConfig =>
    ({ id: "a", spawn: { command, args } }) as unknown as AgentConfig;

  it("finds the container of a docker exec spawn and nothing else", () => {
    expect(slotContainerOf({ command: "docker", args: ["exec", "-i", "cerase-agent-1", "opencode", "acp"] })).toBe(
      "cerase-agent-1",
    );
    expect(slotContainerOf({ command: "/usr/bin/docker", args: ["exec", "cerase-agent-2", "opencode"] })).toBe(
      "cerase-agent-2",
    );
    expect(slotContainerOf({ command: "env", args: ["--", "node", "fake.mjs"] })).toBeNull();
    expect(slotContainerOf({ command: "docker", args: ["run", "-i", "x"] })).toBeNull();
  });

  it("reads a stopped, restarting or newer container as restarted, and the same one as not", () => {
    const since = Date.parse("2026-10-02T20:20:07.522Z");
    const state = (s: object) => JSON.stringify(s);
    expect(stateRestartedSince(state({ Running: false, Restarting: false }), since)).toBe(true);
    expect(stateRestartedSince(state({ Running: true, Restarting: true }), since)).toBe(true);
    expect(stateRestartedSince(state({ Running: true, StartedAt: "2026-10-02T20:20:24.426273156Z" }), since)).toBe(
      true,
    );
    expect(stateRestartedSince(state({ Running: true, StartedAt: "2026-10-02T16:57:38.046354724Z" }), since)).toBe(
      false,
    );
    expect(stateRestartedSince("not json", since)).toBe(false);
  });

  it("looks a second time before answering no, and answers no for a container it cannot read", async () => {
    const since = Date.parse("2026-10-02T20:20:07.522Z");
    const docker = agent("docker", ["exec", "-i", "cerase-agent-1", "opencode", "acp"]);
    const replies = (outs: { stdout: string; ok: boolean }[]) => {
      const calls: string[][] = [];
      const exec: SlotExec = async (args) => {
        calls.push(args);
        return outs[calls.length - 1] ?? { stdout: "", ok: false };
      };
      return { exec, calls };
    };
    const before = JSON.stringify({ Running: true, StartedAt: "2026-10-02T16:57:38Z" });
    const after = JSON.stringify({ Running: true, StartedAt: "2026-10-02T20:20:24Z" });

    const late = replies([
      { stdout: before, ok: true },
      { stdout: after, ok: true },
    ]);
    expect(await dockerSlotRestartProbe(late.exec, 1)(docker, since)).toBe(true);
    expect(late.calls[0]).toEqual(["inspect", "--format", "{{json .State}}", "cerase-agent-1"]);

    const same = replies([
      { stdout: before, ok: true },
      { stdout: before, ok: true },
    ]);
    expect(await dockerSlotRestartProbe(same.exec, 1)(docker, since)).toBe(false);
    expect(same.calls).toHaveLength(2);

    const gone = replies([]);
    expect(await dockerSlotRestartProbe(gone.exec, 1)(docker, since)).toBe(false);

    const notDocker = replies([]);
    expect(await dockerSlotRestartProbe(notDocker.exec, 1)(agent("env", ["node", "x"]), since)).toBe(false);
    expect(notDocker.calls).toHaveLength(0);
  });
});

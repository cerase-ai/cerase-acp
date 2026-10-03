#!/usr/bin/env node
// Test fixture: a minimal ACP "agent" that speaks JSON-RPC 2.0 NDJSON on
// stdio. Used by session-manager.test.ts to exercise the full ACP loop
// without needing OpenCode running. Plain .mjs (no TypeScript) so the
// session manager can spawn it directly with `node` — no transpilation.
//
// Env knobs:
//   FAKE_REPLY              — reply text (default "hello world")
//   FAKE_CHUNKS             — number of session/update chunks (default 3)
//   FAKE_HANG_PROMPT        — set to "1" to NEVER answer session/prompt
//                              (hung-child simulation for the watchdog)
//   FAKE_CRASH_AFTER_PROMPT — set to "1" to exit(0) after responding to
//                              one prompt. Used to test crash-respawn.
//   FAKE_DELAY_MS_PER_CHUNK — sleep ms between chunks (default 0)
//   FAKE_LATE_BURST_TEXT    — extra text emitted AFTER the prompt RPC
//                              reply, split into one-char chunks each
//                              FAKE_LATE_BURST_INTERVAL_MS apart.
//                              Simulates opencode upstream race #17505
//                              where session/update notifications
//                              continue streaming after end_turn.
//   FAKE_LATE_BURST_INTERVAL_MS — ms between successive late-burst
//                              chunks (default 100).
//   FAKE_ECHO_PROMPT        — set to "1" to reply with the prompt text the
//                              parent sent instead of FAKE_REPLY. The only
//                              way a test can read what the bridge told the
//                              assistant, which is what the attach-failure
//                              correction has to be checked on. Set to
//                              "blocks" to reply with every block of the
//                              prompt, each as `<audience>: <text>`, where
//                              the audience is the block's annotation or
//                              `everyone` without one.
//   FAKE_OUTGROWN_FILE      — a file of session ids, one per line, where `*`
//                              lists every session. A prompt
//                              on a listed session is refused the way
//                              opencode 1.18.18 refuses a session too large
//                              to summarise: JSON-RPC -32603 "Internal error:
//                              Session too large to compact - …" with data
//                              { service: "session", errorName:
//                              "ContextOverflowError" }.
//   FAKE_OUTGROWN_ERROR_NAME — the errorName that refusal carries instead,
//                              for a test of what is not matched.
//   FAKE_EXIT_DELAY_MS      — on SIGTERM, wait this long before exiting: a
//                              child that outlives the kill for a while, as a
//                              `docker exec` child does while it tears down.
//   FAKE_MESSAGE_ID         — when set, attach this messageId to every
//                              agent_message_chunk / agent_thought_chunk
//                              update. Production opencode-acp always
//                              includes a messageId; M16 reconciliation
//                              needs it to address the canonical record.
//   FAKE_MODES              — comma-separated session mode ids this agent
//                              advertises at session/new, and the only ones
//                              session/set_mode accepts. Unset means the
//                              agent advertises no mode system at all and
//                              answers set_mode with "method not found",
//                              which is what every test that does not care
//                              about modes exercises.
//   FAKE_MODES_SHAPE        — where the advertisement is carried. "config"
//                              (default) puts it in configOptions under the
//                              mode category, which is what opencode 1.18.18
//                              sends; "modes" puts it in the spec's own
//                              modes object. Both are legal ACP and a client
//                              that reads only one is blind to half the
//                              agents it can meet.
//   FAKE_ECHO_MODE          — set to "1" to reply with the session's current
//                              mode id instead of FAKE_REPLY. The only way a
//                              test can see which profile the session ended
//                              up under, which is the whole question a silent
//                              downgrade hides.
//   FAKE_MODEL              — the provider/model pair a NEW session starts
//                              on, the slot's default. When set, session/new
//                              and session/load carry a model select option
//                              in configOptions, the way opencode does.
//   FAKE_LOADED_MODEL       — the pair session/load restores. opencode takes
//                              it from the session's last user message, so it
//                              can differ from the default; unset means the
//                              same as FAKE_MODEL.
//   FAKE_SET_MODEL_FAILS    — set to "1" to answer session/set_config_option
//                              for the model with an error, as opencode does
//                              for a model its config does not define.
//   FAKE_ECHO_MODEL         — set to "1" to reply with the model the session
//                              is on when the prompt arrives. The only way a
//                              test can see which model a turn ran on, rather
//                              than which calls were made before it.
//   FAKE_SLOT_DOWN_FILE     — while this file exists, exit 1 at start without
//                              writing a byte: what `docker exec` does against
//                              a slot that is stopped or restarting.
//   FAKE_RESTART_MID_PROMPT_FILE — when this file exists at session/prompt,
//                              remove it, send one thought chunk and exit 137:
//                              what a `docker exec` child does when its slot
//                              restarts under a turn the assistant has started.
//                              With FAKE_SLOT_DOWN_FILE set too, the slot stays
//                              down after it: that file is created first.
//   FAKE_RESTART_SAYS       — what that dying child had started to answer: sent
//                              as a message chunk instead of the thought chunk.
//   FAKE_ECHO_SESSION       — set to "1" to open the reply with a line
//                              `session=<id>` naming the session the prompt
//                              was sent to. A bridge restart is the one place
//                              the session cannot be read off the manager,
//                              because the manager is a different object after
//                              it.
//   FAKE_PROMPT_LOG         — a file each session/prompt appends one line to:
//                              the JSON of the prompt's last text block, the
//                              person's message. What the assistant was sent,
//                              counted across every child and every bridge.

import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const SLOT_DOWN_FILE = process.env.FAKE_SLOT_DOWN_FILE;
const RESTART_MID_PROMPT_FILE = process.env.FAKE_RESTART_MID_PROMPT_FILE;
if (SLOT_DOWN_FILE && existsSync(SLOT_DOWN_FILE)) process.exit(1);

const EXIT_DELAY_MS = parseInt(process.env.FAKE_EXIT_DELAY_MS ?? "0", 10);
if (EXIT_DELAY_MS > 0) {
  process.on("SIGTERM", () => {
    setTimeout(() => process.exit(0), EXIT_DELAY_MS);
  });
}

const REPLY = process.env.FAKE_REPLY ?? "hello world";
const CHUNKS = parseInt(process.env.FAKE_CHUNKS ?? "3", 10);
const CRASH_AFTER_PROMPT = process.env.FAKE_CRASH_AFTER_PROMPT === "1";
const DELAY_MS = parseInt(process.env.FAKE_DELAY_MS_PER_CHUNK ?? "0", 10);
// FAKE_KIND chooses which session/update kind to emit:
//   "message" (default) → agent_message_chunk (user-visible reply)
//   "thought"           → agent_thought_chunk (chain-of-thought; the
//                         CLI normally hides these, fallback path
//                         in M11 surfaces them when no message exists)
const KIND = process.env.FAKE_KIND ?? "message";
const UPDATE_KIND = KIND === "thought" ? "agent_thought_chunk" : "agent_message_chunk";
const LATE_BURST_TEXT = process.env.FAKE_LATE_BURST_TEXT;
const LATE_BURST_INTERVAL_MS = parseInt(process.env.FAKE_LATE_BURST_INTERVAL_MS ?? "100", 10);
const MESSAGE_ID = process.env.FAKE_MESSAGE_ID;
const ECHO_PROMPT = process.env.FAKE_ECHO_PROMPT === "1";
const ECHO_BLOCKS = process.env.FAKE_ECHO_PROMPT === "blocks";
const OUTGROWN_FILE = process.env.FAKE_OUTGROWN_FILE;
const OUTGROWN_ERROR_NAME = process.env.FAKE_OUTGROWN_ERROR_NAME ?? "ContextOverflowError";

/** Whether this session id is listed as too large to summarise. */
function outgrown(sessionId) {
  if (!OUTGROWN_FILE || !existsSync(OUTGROWN_FILE)) return false;
  return readFileSync(OUTGROWN_FILE, "utf8")
    .split("\n")
    .some((line) => line.trim() === sessionId || line.trim() === "*");
}
// Session resume. Off by default so every existing test keeps exercising the
// cold-start path; the real slot answers true (measured against the running
// binary, which also offers close/fork/list/resume).
const LOAD_SESSION = process.env.FAKE_LOAD_SESSION === "1";
const LOAD_FAILS = process.env.FAKE_LOAD_FAILS === "1";
// The advertised session modes. An empty list means the agent has no mode
// system, which is a different answer from having one that lacks the mode
// asked for, and the two must not collapse into the same fixture.
const MODES = (process.env.FAKE_MODES ?? "")
  .split(",")
  .map((m) => m.trim())
  .filter((m) => m.length > 0);
const MODES_SHAPE = process.env.FAKE_MODES_SHAPE ?? "config";
const ECHO_MODE = process.env.FAKE_ECHO_MODE === "1";
const DEFAULT_MODEL = process.env.FAKE_MODEL;
const LOADED_MODEL = process.env.FAKE_LOADED_MODEL ?? DEFAULT_MODEL;
const SET_MODEL_FAILS = process.env.FAKE_SET_MODEL_FAILS === "1";
const ECHO_MODEL = process.env.FAKE_ECHO_MODEL === "1";

// The mode this fixture is in. Starts at the first advertised one, the way a
// real agent starts at its default rather than at nothing.
let currentMode = MODES[0];
// The model this fixture's session is on. Set by session/new and session/load
// and moved by session/set_config_option, as in opencode.
let currentModel;

/** The advertisement carried by session/new and session/load. */
function modeAdvertisement() {
  const configOptions = [];
  if (currentModel !== undefined) {
    // opencode lists the model option first and formats its value as
    // providerID/modelID.
    const known = [...new Set([DEFAULT_MODEL, LOADED_MODEL, currentModel].filter((m) => m !== undefined))];
    configOptions.push({
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModel,
      options: known.map((value) => ({ value, name: value })),
    });
  }
  const out = {};
  if (MODES.length > 0 && MODES_SHAPE === "modes") {
    out.modes = {
      currentModeId: currentMode,
      availableModes: MODES.map((id) => ({ id, name: id })),
    };
  } else if (MODES.length > 0) {
    configOptions.push({
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
      currentValue: currentMode,
      options: MODES.map((id) => ({ value: id, name: id })),
    });
  }
  if (configOptions.length > 0) out.configOptions = configOptions;
  return out;
}

const send = (msg) => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let promptsHandled = 0;

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (_e) {
    return;
  }

  // Notification (no id) — no response expected
  if (msg.id === undefined) {
    if (msg.method === "session/cancel") {
      // ACP allows the agent to emit final updates after cancel.
      // For this fixture we just stop emitting.
    }
    return;
  }

  // Requests
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: LOAD_SESSION,
          promptCapabilities: { audio: false, embeddedContext: false, image: false },
        },
        authMethods: [],
      },
    });
    return;
  }

  if (msg.method === "session/new") {
    // Echo the cwd we received back in the sessionId so the session-
    // manager test can assert on what the bridge actually passed. The pid
    // makes each fresh session distinguishable from every other, which is
    // what lets a test tell a resumed session from a re-created one.
    const cwd = msg.params?.cwd ?? "<none>";
    currentModel = DEFAULT_MODEL;
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { sessionId: `fake-session-cwd=${cwd}#${process.pid}`, ...modeAdvertisement() },
    });
    return;
  }

  if (msg.method === "session/load") {
    if (LOAD_FAILS) {
      // What a real slot answers after its opencode.db was reset by a
      // version bump: the id is well-formed and the session is gone.
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32602, message: "session not found" },
      });
      return;
    }
    currentModel = LOADED_MODEL;
    send({ jsonrpc: "2.0", id: msg.id, result: modeAdvertisement() });
    return;
  }

  if (msg.method === "session/set_config_option") {
    if (msg.params?.configId !== "model") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32602, message: `Invalid params: unknown config option: ${msg.params?.configId}` },
      });
      return;
    }
    if (SET_MODEL_FAILS) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32602, message: `Invalid params: model not found: ${msg.params?.value}` },
      });
      return;
    }
    currentModel = msg.params?.value;
    send({ jsonrpc: "2.0", id: msg.id, result: modeAdvertisement() });
    return;
  }

  if (msg.method === "session/set_mode") {
    const wanted = msg.params?.modeId;
    if (MODES.length === 0) {
      // No mode system. Answering "method not found" is what an agent that
      // never implemented session modes replies, and it is the path every
      // test that says nothing about modes takes.
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      });
      return;
    }
    if (!MODES.includes(wanted)) {
      // Verbatim what opencode answers for a mode its config does not define.
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32602, message: `Invalid params: mode not found: ${wanted}`, data: { mode: wanted } },
      });
      return;
    }
    currentMode = wanted;
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }

  if (msg.method === "authenticate") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }

  if (msg.method === "session/prompt") {
    // M-ACP-2: simulate a hung opencode child — never answer the prompt
    // RPC (the watchdog must kill us; without it the user's queue blocks
    // forever).
    const sessionId = msg.params?.sessionId;
    if (process.env.FAKE_PROMPT_LOG) {
      const blocks = msg.params?.prompt ?? [];
      appendFileSync(process.env.FAKE_PROMPT_LOG, `${JSON.stringify(blocks[blocks.length - 1]?.text ?? "")}\n`);
    }
    if (process.env.FAKE_HANG_PROMPT === "1") return;
    if (RESTART_MID_PROMPT_FILE && existsSync(RESTART_MID_PROMPT_FILE)) {
      rmSync(RESTART_MID_PROMPT_FILE);
      if (SLOT_DOWN_FILE) writeFileSync(SLOT_DOWN_FILE, "");
      const says = process.env.FAKE_RESTART_SAYS;
      const update = says
        ? { sessionUpdate: "agent_message_chunk", content: { type: "text", text: says } }
        : { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "…" } };
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
      await sleep(20);
      process.exit(137);
    }
    if (outgrown(sessionId)) {
      // Verbatim what opencode 1.18.18's ACP layer sends when the summary
      // call failed as too large: RequestError.internalError(data, message).
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32603,
          message:
            "Internal error: Session too large to compact - context exceeds model limit even after stripping media",
          data: { service: "session", errorName: OUTGROWN_ERROR_NAME },
        },
      });
      return;
    }
    // Split the reply into roughly CHUNKS pieces and emit as session/update
    // notifications with sessionUpdate: agent_message_chunk.
    const answer = ECHO_MODEL
      ? (currentModel ?? "<no-model>")
      : ECHO_MODE
        ? (currentMode ?? "<no-mode>")
        : ECHO_BLOCKS
          ? (msg.params?.prompt ?? [])
              .map((b) => `${b.annotations?.audience?.join(",") ?? "everyone"}: ${b.text ?? ""}`)
              .join("\n\n")
          : ECHO_PROMPT
            ? (msg.params?.prompt?.[0]?.text ?? "")
            : REPLY;
    const reply = process.env.FAKE_ECHO_SESSION === "1" ? `session=${sessionId}\n${answer}` : answer;
    const pieces = [];
    const chunkLen = Math.max(1, Math.ceil(reply.length / CHUNKS));
    for (let i = 0; i < reply.length; i += chunkLen) {
      pieces.push(reply.slice(i, i + chunkLen));
    }
    for (const text of pieces) {
      const update = {
        sessionUpdate: UPDATE_KIND,
        content: { type: "text", text },
      };
      if (MESSAGE_ID) update.messageId = MESSAGE_ID;
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update },
      });
      if (DELAY_MS > 0) await sleep(DELAY_MS);
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    promptsHandled += 1;

    // Simulate upstream opencode race #17505: emit a burst of
    // session/update notifications AFTER the prompt RPC reply, each
    // separated by LATE_BURST_INTERVAL_MS. The parent's drain loop
    // must keep its window open for the full burst duration; the
    // (interval < idle_ms) shape means lastUpdateAt is refreshed
    // each tick so only the ceiling cuts us off.
    if (LATE_BURST_TEXT !== undefined && LATE_BURST_TEXT.length > 0) {
      for (const ch of LATE_BURST_TEXT) {
        await sleep(LATE_BURST_INTERVAL_MS);
        const update = {
          sessionUpdate: UPDATE_KIND,
          content: { type: "text", text: ch },
        };
        if (MESSAGE_ID) update.messageId = MESSAGE_ID;
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update },
        });
      }
    }

    if (CRASH_AFTER_PROMPT && promptsHandled >= 1) {
      // Flush + exit cleanly. From the parent's perspective the child
      // disconnected mid-conversation — exactly the path the session
      // manager's crash-respawn logic must cope with.
      await sleep(20);
      process.exit(0);
    }
    return;
  }

  // Unknown method
  send({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: -32601, message: `Method not found: ${msg.method}` },
  });
});

// Graceful exit when stdin closes (parent killed us)
rl.on("close", () => {
  process.exit(0);
});

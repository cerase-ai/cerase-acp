#!/usr/bin/env node
// Test fixture: a minimal ACP "agent" that speaks JSON-RPC 2.0 NDJSON on
// stdio. Used by session-manager.test.ts to exercise the full ACP loop
// without needing OpenCode running. Plain .mjs (no TypeScript) so the
// session manager can spawn it directly with `node` — no transpilation.
//
// Env knobs:
//   FAKE_REPLY              — reply text (default "hello world")
//   FAKE_CHUNKS             — number of session/update chunks (default 3)
//   FAKE_CRASH_AFTER_PROMPT — set to "1" to exit(0) after responding to
//                              one prompt. Used to test crash-respawn.
//   FAKE_DELAY_MS_PER_CHUNK — sleep ms between chunks (default 0)

import readline from "node:readline";

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

const send = (msg) => {
  process.stdout.write(JSON.stringify(msg) + "\n");
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let promptsHandled = 0;

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
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
          loadSession: false,
          promptCapabilities: { audio: false, embeddedContext: false, image: false },
        },
        authMethods: [],
      },
    });
    return;
  }

  if (msg.method === "session/new") {
    // Echo the cwd we received back in the sessionId so the session-
    // manager test can assert on what the bridge actually passed.
    const cwd = msg.params?.cwd ?? "<none>";
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { sessionId: `fake-session-cwd=${cwd}` },
    });
    return;
  }

  if (msg.method === "authenticate") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }

  if (msg.method === "session/prompt") {
    const sessionId = msg.params?.sessionId;
    // Split REPLY into roughly CHUNKS pieces and emit as session/update
    // notifications with sessionUpdate: agent_message_chunk.
    const pieces = [];
    const chunkLen = Math.max(1, Math.ceil(REPLY.length / CHUNKS));
    for (let i = 0; i < REPLY.length; i += chunkLen) {
      pieces.push(REPLY.slice(i, i + chunkLen));
    }
    for (const text of pieces) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: UPDATE_KIND,
            content: { type: "text", text },
          },
        },
      });
      if (DELAY_MS > 0) await sleep(DELAY_MS);
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    promptsHandled += 1;
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

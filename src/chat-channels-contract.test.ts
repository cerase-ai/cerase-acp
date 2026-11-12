// Every chat channel the console offers an organisation has an adapter here
// that sends a message and draws a platform notice. Each channel's row in
// specs/turns.tsv names the adapter the bridge must build for it.
//
// The list is cerase-core's, the file its console suite holds the console's
// choices to, vendored here and pinned in scripts/TOOLING.sha256. A channel
// added there without an adapter here is red in this file; a channel offered in
// the console and missing there is red in cerase-core.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createChatAdapter } from "./chat-adapter.js";
import { type AgentConfig, ChatChannelSchema } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";
import { specRow, specTest } from "./test-support/spec-rows.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = "control-plane/tests/fixtures/chat-channels.json";

const contract = JSON.parse(readFileSync(join(repoRoot, FIXTURE), "utf8")) as { channels: string[] };

const CHANNEL_ROW_IDS = ["ACP-TURN-035", "ACP-TURN-036", "ACP-TURN-037", "ACP-TURN-038"] as const;

/** The credentials each channel's configuration requires, with values that are not real. */
const CREDENTIALS: Record<string, Partial<AgentConfig>> = {
  discord: { bot_token: "contract-discord-token" },
  telegram: { bot_token: "123456:contract-telegram-token" },
  slack: { bot_token: "xoxb-contract", slack_app_token: "xapp-contract" },
  workspace_chat: { workspace_chat: { project_number: "123456789012", credentials_path: "/nonexistent/key.json" } },
};

describe("the channels an organisation may choose", () => {
  it("are pinned to the copy cerase-core wrote", () => {
    const pin = readFileSync(join(repoRoot, "scripts", "TOOLING.sha256"), "utf8");
    const digest = createHash("sha256")
      .update(readFileSync(join(repoRoot, FIXTURE)))
      .digest("hex");
    expect(pin).toContain(`${digest}  ${FIXTURE}`);
  });

  specTest("ACP-TURN-013", "are every channel the bridge configures, the console's own transport aside", (row) => {
    expect([...contract.channels].sort()).toEqual(ChatChannelSchema.options.filter((c) => c !== "web").sort());

    const configured = ChatChannelSchema.options.filter((channel) => channel !== "web").sort();
    const same = JSON.stringify([...contract.channels].sort()) === JSON.stringify(configured);
    const observed = same
      ? "it equals every channel the bridge configures, the console's own transport aside"
      : "it does not equal every channel the bridge configures";
    expect(observed).toBe(row.expect);
  });

  specTest.each(CHANNEL_ROW_IDS)(
    "%s has an adapter that sends a message, draws a notice and closes it",
    async (row) => {
      const [agentId, channel] = row.quoted("when");
      if (agentId === undefined || channel === undefined) {
        throw new Error("the row does not name an agent and a channel");
      }

      expect(CREDENTIALS[channel], `no configuration for ${channel} in this test`).toBeDefined();
      const agent = {
        id: agentId,
        channel,
        allowed_users: ["u1"],
        cwd: "/home/agent/cerase/workspace",
        mode: "cerase",
        spawn: { command: "docker", args: [] },
        ...CREDENTIALS[channel],
      } as AgentConfig;

      const adapter = await createChatAdapter(agent, {} as unknown as Dispatcher);

      expect(adapter.agentId).toBe(agentId);
      expect(adapter.makeSendTarget).toBeTypeOf("function");
      expect(adapter.sendNotice).toBeTypeOf("function");
      // A decided approval's message says how it ended, on every channel core offers.
      expect(adapter.closeNotice).toBeTypeOf("function");
      expect(adapter.start).toBeTypeOf("function");

      const missing = [
        adapter.agentId === agentId ? "" : `the agent id ${agentId}`,
        typeof adapter.makeSendTarget === "function" ? "" : "makeSendTarget",
        typeof adapter.sendNotice === "function" ? "" : "sendNotice",
        typeof adapter.closeNotice === "function" ? "" : "closeNotice",
        typeof adapter.start === "function" ? "" : "start",
      ].filter((part) => part !== "");
      const observed =
        missing.length === 0
          ? `the bridge builds an adapter for ${adapter.agentId} that sends a message, draws a notice, closes it and starts`
          : `the bridge builds an adapter for ${adapter.agentId} that is missing ${missing.join(", ")}`;
      expect(observed).toBe(row.expect);
    },
  );

  it("are the channels the four rows quote", () => {
    const quoted = CHANNEL_ROW_IDS.map((id) => specRow(id).quoted("when")[1] ?? "");
    expect(quoted.sort()).toEqual([...contract.channels].sort());
  });
});

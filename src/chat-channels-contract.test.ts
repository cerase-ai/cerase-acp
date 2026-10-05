// Every chat channel the console offers an organisation has an adapter here
// that sends a message and draws a platform notice.
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

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = "control-plane/tests/fixtures/chat-channels.json";

const contract = JSON.parse(readFileSync(join(repoRoot, FIXTURE), "utf8")) as { channels: string[] };

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

  it("are every channel the bridge configures, the console's own transport aside", () => {
    expect([...contract.channels].sort()).toEqual(ChatChannelSchema.options.filter((c) => c !== "web").sort());
  });

  it.each(contract.channels)("%s has an adapter that sends a message and draws a notice", async (channel) => {
    expect(CREDENTIALS[channel], `no configuration for ${channel} in this test`).toBeDefined();
    const agent = {
      id: "agent-1",
      channel,
      allowed_users: ["u1"],
      cwd: "/home/agent/cerase/workspace",
      mode: "cerase",
      spawn: { command: "docker", args: [] },
      ...CREDENTIALS[channel],
    } as AgentConfig;

    const adapter = await createChatAdapter(agent, {} as unknown as Dispatcher);

    expect(adapter.agentId).toBe("agent-1");
    expect(adapter.makeSendTarget).toBeTypeOf("function");
    expect(adapter.sendNotice).toBeTypeOf("function");
    expect(adapter.start).toBeTypeOf("function");
  });
});

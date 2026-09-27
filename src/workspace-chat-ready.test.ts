import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeServiceAccount, writeKeyFile } from "./__tests__/fake-google.js";
import { type ChatAdapter, createChatAdapter } from "./chat-adapter.js";
import type { AgentConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";

process.env.WORKSPACE_CHAT_PORT = "0";

// A Chat assistant reported no readiness at all, the console read that as
// «never ready», and a machine on Chat failed every release on the doctor.
describe("a Google Chat assistant's readiness", () => {
  let dir: string | undefined;
  let adapter: ChatAdapter | undefined;

  afterEach(async () => {
    await adapter?.stop();
    adapter = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function started(): Promise<ChatAdapter> {
    dir = mkdtempSync(join(tmpdir(), "wc-ready-"));
    const keyPath = join(dir, "service-account.json");
    writeKeyFile(keyPath, makeServiceAccount(), "https://oauth2.googleapis.com/token");
    const agent: AgentConfig = {
      id: "agent-1",
      channel: "workspace_chat",
      allowed_users: ["mario.rossi@example.com"],
      cwd: "/home/agent/cerase/workspace",
      mode: "cerase",
      spawn: { command: "docker", args: [] },
      workspace_chat: { project_number: "123456789012", credentials_path: keyPath, allowed_domains: ["example.com"] },
    };
    return createChatAdapter(agent, {} as unknown as Dispatcher);
  }

  it("is ready once the webhook is serving it, and not before or after", async () => {
    adapter = await started();
    expect(adapter.ready?.()).toBe(false);
    await adapter.start();
    expect(adapter.ready?.()).toBe(true);
    await adapter.stop();
    expect(adapter.ready?.()).toBe(false);
    adapter = undefined;
  });
});

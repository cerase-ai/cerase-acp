import { describe, expect, it } from "vitest";
import type { AgentConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";
import { createWebAdapter } from "./web-adapter.js";

const AGENT = {
  id: "maintainer-1",
  channel: "web",
  allowed_users: ["maintainer:org-123"],
  cwd: "/home/agent/cerase/workspace",
  spawn: { command: "docker", args: [] },
} as unknown as AgentConfig;

const DISPATCHER = {} as unknown as Dispatcher;

describe("web-adapter (C2-0 null-sink channel)", () => {
  it("exposes the agent id and no-op start/stop", async () => {
    const a = createWebAdapter(AGENT, DISPATCHER);
    expect(a.agentId).toBe("maintainer-1");
    await expect(a.start()).resolves.toBeUndefined();
    await expect(a.stop()).resolves.toBeUndefined();
  });

  it("makeSendTarget returns a sink that discards chunks and reports ok", async () => {
    const a = createWebAdapter(AGENT, DISPATCHER);
    const send = a.makeSendTarget("maintainer:org-123");
    // The reply is read from the opencode timeline; discarding here is
    // success for the web channel.
    await expect(send("hello from the maintainer")).resolves.toEqual({ ok: true });
  });

  // The console's Chat links each `[[attach:]]` file of a turn from the
  // transcript and serves it from the workspace, so on this channel a file is
  // delivered the moment the reply carries its marker. Without a sendFile the
  // bridge recorded every attachment as one this channel cannot carry, and the
  // assistant followed each file it had just made with «the file did not reach
  // you» under the download link.
  it("reports an attached file delivered: the console links it from the transcript", async () => {
    const a = createWebAdapter(AGENT, DISPATCHER);
    expect(a.sendFile).toBeTypeOf("function");
    await expect(a.sendFile?.("maintainer:org-123", { name: "report.docx", bytes: Buffer.from("x") })).resolves.toEqual(
      { ok: true },
    );
  });
});

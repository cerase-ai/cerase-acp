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
    // The reply is read from the opencode timeline; discarding here IS success
    // for the web channel (M-ACP-FAILLOUD-1) — it must report `{ ok: true }`.
    await expect(send("hello from the maintainer")).resolves.toEqual({ ok: true });
  });

  it("does not implement sendFile (attachments unsupported on web)", () => {
    const a = createWebAdapter(AGENT, DISPATCHER);
    expect(a.sendFile).toBeUndefined();
  });
});

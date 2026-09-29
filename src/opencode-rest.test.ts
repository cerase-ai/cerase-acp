import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultEndpointForAgent, execFetcher, SLOT_REST_SCRIPT, type SlotExec } from "./opencode-rest.js";

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

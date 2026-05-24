import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

function writeSampleConfig(
  dir: string,
  reply: string,
  allowed: string[] = ["111"],
  kind: "message" | "thought" = "message",
): string {
  const path = join(dir, "agents.yaml");
  writeFileSync(
    path,
    `
agents:
  - id: demo
    bot_token: irrelevant-cli-does-not-touch-discord
    allowed_users: ${JSON.stringify(allowed)}
    spawn:
      command: env
      args: ["--", "FAKE_REPLY=${reply}", "FAKE_KIND=${kind}", "node", "${FAKE_CHILD}"]
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`,
  );
  return path;
}

interface CapturedOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function capture(argv: string[]): Promise<CapturedOutput> {
  let stdout = "";
  let stderr = "";
  const result = await runCli(argv, {
    stdoutWrite: (s) => {
      stdout += s;
    },
    stderrWrite: (s) => {
      stderr += s;
    },
  });
  return { stdout, stderr, exitCode: result };
}

describe("runCli", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cerase-acp-cli-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("streams the agent reply to stdout and exits 0 on the happy path", async () => {
    const cfg = writeSampleConfig(dir, "ciao da fake-acp");
    const out = await capture([
      "prompt",
      "--config",
      cfg,
      "--agent",
      "demo",
      "--user",
      "111",
      "ping",
    ]);
    expect(out.exitCode).toBe(0);
    // chunks may interleave but the concatenation must be exact
    expect(out.stdout.replace(/\n+$/u, "")).toBe("ciao da fake-acp");
  });

  it("message-only: reply on stdout, no `thinking:` block on stderr", async () => {
    const cfg = writeSampleConfig(dir, "regular reply");
    const out = await capture([
      "prompt",
      "--config",
      cfg,
      "--agent",
      "demo",
      "--user",
      "111",
      "ping",
    ]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.replace(/\n+$/u, "")).toBe("regular reply");
    expect(out.stderr).not.toMatch(/thinking:/);
    expect(out.stdout).not.toMatch(/no direct reply/);
  });

  it("thought-only (opencode-acp drops the content): thought streams to stderr, stdout shows the empty-reply note", async () => {
    // FAKE_KIND=thought → the fake child emits text as
    // agent_thought_chunk, mirroring what opencode-acp does to
    // reasoning-model `content` fields. User-facing stdout would
    // otherwise be empty.
    const cfg = writeSampleConfig(dir, "this is a thought", ["111"], "thought");
    const out = await capture([
      "prompt",
      "--config",
      cfg,
      "--agent",
      "demo",
      "--user",
      "111",
      "ping",
    ]);
    expect(out.exitCode).toBe(0);
    // Stderr carries the thinking block (label + content)
    expect(out.stderr).toMatch(/thinking:/);
    expect(out.stderr).toMatch(/this is a thought/);
    // Stdout flags the empty reply explicitly so stdout-only consumers
    // know the agent didn't speak (rather than thinking everything is fine)
    expect(out.stdout).toMatch(/no direct reply from the agent/i);
  });

  it("prints the polite refusal and still exits 0 for an unauthorised user", async () => {
    const cfg = writeSampleConfig(dir, "never seen");
    const out = await capture([
      "prompt",
      "--config",
      cfg,
      "--agent",
      "demo",
      "--user",
      "999",
      "hi",
    ]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toMatch(/not authorised|non sono autorizzato/i);
  });

  it("exits 1 with a clear error when the agent id is unknown", async () => {
    const cfg = writeSampleConfig(dir, "x");
    const out = await capture([
      "prompt",
      "--config",
      cfg,
      "--agent",
      "ghost",
      "--user",
      "111",
      "hi",
    ]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toMatch(/ghost/);
  });

  it("exits 1 when a required flag is missing", async () => {
    const cfg = writeSampleConfig(dir, "x");
    const out = await capture([
      "prompt",
      "--config",
      cfg,
      // --agent omitted
      "--user",
      "111",
      "hi",
    ]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toMatch(/--agent/);
  });

  it("exits 1 when no prompt text is provided", async () => {
    const cfg = writeSampleConfig(dir, "x");
    const out = await capture([
      "prompt",
      "--config",
      cfg,
      "--agent",
      "demo",
      "--user",
      "111",
      // no positional text
    ]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toMatch(/prompt|text/i);
  });

  it("exits 1 with a clear error when the config file is missing", async () => {
    const out = await capture([
      "prompt",
      "--config",
      "/nonexistent/agents.yaml",
      "--agent",
      "demo",
      "--user",
      "111",
      "hi",
    ]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toMatch(/agents\.yaml|config/i);
  });

  it("--help prints usage and exits 0", async () => {
    const out = await capture(["--help"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toMatch(/usage|prompt/i);
  });

  it("unknown subcommand exits 1 with usage hint", async () => {
    const out = await capture(["explode"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toMatch(/unknown|usage/i);
  });
});

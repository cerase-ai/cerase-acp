import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

const WRAPPER = fileURLToPath(new URL("../scripts/cerase-acp-cli", import.meta.url));
const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runWrapper(args: string[], opts?: { input?: string; env?: Record<string, string> }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", [WRAPPER, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...opts?.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    if (opts?.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

function writeSampleConfig(dir: string): string {
  const path = join(dir, "agents.yaml");
  writeFileSync(
    path,
    `
agents:
  - id: demo
    bot_token: irrelevant
    allowed_users: ["111"]
    spawn:
      command: env
      args: ["--", "FAKE_REPLY=hello from wrapper", "node", "${FAKE_CHILD}"]
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`,
  );
  return path;
}

describe("cerase-acp-cli (bash wrapper)", () => {
  let dir: string;

  beforeAll(async () => {
    // The wrapper invokes `node dist/cli.js`; ensure dist is current.
    await new Promise<void>((resolve, reject) => {
      const child = spawn("npm", ["run", "build"], { cwd: REPO_ROOT });
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`build exit ${code}`))));
    });
  }, 30_000);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cerase-acp-wrapper-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("--help prints usage and exits 0", async () => {
    const r = await runWrapper(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage|prompt|repl|inject/i);
  });

  it("unknown subcommand exits non-zero with a usage hint", async () => {
    const r = await runWrapper(["nope"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/unknown|usage/i);
  });

  it("`prompt` dispatches to the TS CLI and streams the reply", async () => {
    const cfg = writeSampleConfig(dir);
    const r = await runWrapper([
      "prompt",
      "--config",
      cfg,
      "--agent",
      "demo",
      "--user",
      "111",
      "ping",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hello from wrapper");
  });

  it("`repl` delegates to the TS in-process REPL and replies per line", async () => {
    // Two stdin lines + EOF. M13: bash `cmd_repl` is now `exec node
    // dist/cli.js repl` — the loop lives in TS, so a single ACP
    // child (fake-acp-child here) handles BOTH lines from one
    // SessionManager. Reply count == 2; the wrapper's job is just
    // to invoke the TS subcommand correctly.
    const cfg = writeSampleConfig(dir);
    const r = await runWrapper(
      ["repl", "--config", cfg, "--agent", "demo", "--user", "111"],
      { input: "ciao\nciao ancora\n" },
    );
    expect(r.code).toBe(0);
    const replies = (r.stdout.match(/hello from wrapper/g) ?? []).length;
    expect(replies).toBe(2);
  });
});

describe("cerase-acp-cli inject (against an in-memory fake daemon)", () => {
  let server: Server | undefined;
  let url = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/_test/inject") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          // echo-style "agent": the reply is the input text upper-cased
          const payload = JSON.parse(body || "{}");
          (server as Server & { lastReply?: string }).lastReply = String(payload.text).toUpperCase();
          res.writeHead(202, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "accepted" }));
        });
        return;
      }
      if (req.method === "GET" && (req.url ?? "").startsWith("/_test/last-reply")) {
        const text = (server as Server & { lastReply?: string }).lastReply ?? "";
        if (!text) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "no reply" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text, chunks: 1 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const addr = server!.address() as AddressInfo;
    url = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  it("inject calls POST /_test/inject then GET /_test/last-reply and prints the reply", async () => {
    const r = await runWrapper([
      "inject",
      "--remote",
      url,
      "--agent",
      "demo",
      "--user",
      "111",
      "hello there",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("HELLO THERE");
  });

  it("inject exits non-zero if the remote returns 404 on last-reply", async () => {
    // Bypass the echo path by hitting a fresh injection — but the fake
    // daemon stores the last reply globally; to simulate the 404 we
    // bring up a separate server that always 404s.
    const blackhole = createServer((_req, res) => {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "no reply" }));
    });
    await new Promise<void>((resolve) => blackhole.listen(0, "127.0.0.1", () => resolve()));
    const addr = blackhole.address() as AddressInfo;
    const blackholeUrl = `http://127.0.0.1:${addr.port}`;
    try {
      const r = await runWrapper([
        "inject",
        "--remote",
        blackholeUrl,
        "--agent",
        "demo",
        "--user",
        "111",
        "test",
      ]);
      expect(r.code).not.toBe(0);
    } finally {
      await new Promise<void>((resolve) => blackhole.close(() => resolve()));
    }
  });
});

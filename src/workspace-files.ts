// CHAT-UX / ATTACH-1 — read a file from an agent's workspace so the
// bridge can upload it as a chat attachment.
//
// The agent's workspace lives at ~/cerase/workspace inside its slot-pool
// container (`cerase-agent-N`); the bridge already has the docker socket
// (OPT-32), so it reads the file with `docker exec <container> cat …`.
// The path is workspace-relative and traversal-guarded upstream
// (isSafeWorkspacePath) — re-checked here as a hard boundary.

import { execFile, spawn } from "node:child_process";
import { isSafeWorkspacePath } from "./attachment.js";

export interface WorkspaceFile {
  name: string;
  bytes: Buffer;
}

/** Injectable for tests: returns the raw file bytes for argv. */
export type FileFetcher = (argv: string[], maxBytes: number) => Promise<Buffer>;

const DEFAULT_WORKSPACE_ROOT =
  process.env.CERASE_AGENT_WORKSPACE_ROOT ?? "/home/agent/cerase/workspace";
// Discord free-tier upload ceiling; the largest common denominator.
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

const realFetcher: FileFetcher = (argv, maxBytes) =>
  new Promise<Buffer>((resolve, reject) => {
    const [bin, ...args] = argv;
    if (!bin) {
      reject(new Error("empty argv for file fetcher"));
      return;
    }
    execFile(
      bin,
      args,
      { encoding: "buffer", maxBuffer: maxBytes + 1 },
      (err: Error | null, stdout: Buffer) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });

export interface ReadWorkspaceOptions {
  workspaceRoot?: string;
  maxBytes?: number;
  fetcher?: FileFetcher;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Read `relPath` from `containerName`'s workspace. Throws on an unsafe
 * path, a missing file (docker exec non-zero), or a file over the size
 * cap — the caller turns the throw into a user-facing message, never a
 * crash.
 */
export async function readAgentWorkspaceFile(
  containerName: string,
  relPath: string,
  opts?: ReadWorkspaceOptions,
): Promise<WorkspaceFile> {
  if (!isSafeWorkspacePath(relPath)) {
    throw new Error(`unsafe workspace path: ${relPath}`);
  }
  const root = opts?.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const fetcher = opts?.fetcher ?? realFetcher;
  const full = `${root}/${relPath}`;
  // execFile (no shell) → the path is a single argv member, so spaces /
  // metacharacters can't inject. `--` stops cat option parsing.
  const bytes = await fetcher(["docker", "exec", containerName, "cat", "--", full], maxBytes);
  if (bytes.length > maxBytes) {
    throw new Error(`workspace file too large (${bytes.length} > ${maxBytes} bytes): ${relPath}`);
  }
  return { name: basename(relPath), bytes };
}

// C4-1 — WRITE side: persist an inbound chat attachment into the agent's
// workspace so the `message-attachment-receiver` skill (which routes files to
// the OCR / transcribe / docreader recipes) can read it. Symmetric to the read
// above: `docker exec -i <container> sh -c 'mkdir -p <dir> && cat > <full>'`
// with the bytes on stdin. The relPath is bridge-built (`uploads/<ts>/<name>`
// with a sanitised name), so it is traversal-safe AND shell-safe (no quotes /
// metacharacters can appear) — re-checked here as a hard boundary.

/** Injectable for tests: writes `bytes` to the process spawned for `argv`. */
export type FileWriter = (argv: string[], bytes: Buffer) => Promise<void>;

const realWriter: FileWriter = (argv, bytes) =>
  new Promise<void>((resolve, reject) => {
    const [bin, ...args] = argv;
    if (!bin) {
      reject(new Error("empty argv for file writer"));
      return;
    }
    const child = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(`workspace write failed (exit ${code}): ${stderr.trim()}`));
    });
    child.stdin.write(bytes);
    child.stdin.end();
  });

export interface WriteWorkspaceOptions {
  workspaceRoot?: string;
  maxBytes?: number;
  writer?: FileWriter;
}

/**
 * Write `bytes` to `relPath` inside `containerName`'s workspace, creating the
 * parent dir. Throws on an unsafe path, a path with a single-quote (would break
 * the `sh -c` quoting — never happens for a sanitised `uploads/…` path, guarded
 * anyway), or a file over the cap.
 */
export async function writeAgentWorkspaceFile(
  containerName: string,
  relPath: string,
  bytes: Buffer,
  opts?: WriteWorkspaceOptions,
): Promise<void> {
  if (!isSafeWorkspacePath(relPath)) {
    throw new Error(`unsafe workspace path: ${relPath}`);
  }
  if (relPath.includes("'")) {
    throw new Error(`unsafe workspace path (quote): ${relPath}`);
  }
  const root = opts?.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const writer = opts?.writer ?? realWriter;
  if (bytes.length > maxBytes) {
    throw new Error(`workspace file too large (${bytes.length} > ${maxBytes} bytes): ${relPath}`);
  }
  const full = `${root}/${relPath}`;
  const dir = full.slice(0, full.lastIndexOf("/"));
  const argv = [
    "docker",
    "exec",
    "-i",
    containerName,
    "sh",
    "-c",
    `mkdir -p '${dir}' && cat > '${full}'`,
  ];
  await writer(argv, bytes);
}

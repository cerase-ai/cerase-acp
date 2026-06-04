// CHAT-UX / ATTACH-1 — read a file from an agent's workspace so the
// bridge can upload it as a chat attachment.
//
// The agent's workspace lives at ~/cerase/workspace inside its slot-pool
// container (`cerase-agent-N`); the bridge already has the docker socket
// (OPT-32), so it reads the file with `docker exec <container> cat …`.
// The path is workspace-relative and traversal-guarded upstream
// (isSafeWorkspacePath) — re-checked here as a hard boundary.

import { execFile } from "node:child_process";
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

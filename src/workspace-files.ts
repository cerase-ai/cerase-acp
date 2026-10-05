// Read a file from an agent's workspace so the bridge can upload it as a chat
// attachment.
//
// The agent's workspace lives at ~/cerase/workspace inside its slot-pool
// container (`cerase-agent-N`); the bridge already reaches the slots through
// Docker, so it reads the file with `docker exec <container> cat …`.
// The path is workspace-relative and traversal-guarded upstream
// (isSafeWorkspacePath) — re-checked here as a hard boundary.

import { execFile, spawn } from "node:child_process";
import { isSafeWorkspacePath } from "./attachment.js";
import { fileLimitBytes } from "./file-limit.js";

export interface WorkspaceFile {
  name: string;
  bytes: Buffer;
}

/** Injectable for tests: returns the raw file bytes for argv. */
export type FileFetcher = (argv: string[], maxBytes: number) => Promise<Buffer>;

const DEFAULT_WORKSPACE_ROOT = process.env.CERASE_AGENT_WORKSPACE_ROOT ?? "/home/agent/cerase/workspace";

const realFetcher: FileFetcher = (argv, maxBytes) =>
  new Promise<Buffer>((resolve, reject) => {
    const [bin, ...args] = argv;
    if (!bin) {
      reject(new Error("empty argv for file fetcher"));
      return;
    }
    execFile(bin, args, { encoding: "buffer", maxBuffer: maxBytes + 1 }, (err: Error | null, stdout: Buffer) => {
      if (err) reject(err);
      else resolve(stdout);
    });
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

// A directory listing is bounded by how many files an agent writes, never by
// how big they are. Generous for any real workspace and still a ceiling.
const LIST_MAX_BYTES = 512 * 1024;

/**
 * The real spelling of `relPath` inside the workspace, resolved one path
 * segment at a time against what the container actually holds.
 *
 * The model writes the path from memory, and a listing it read once teaches it
 * a casing that belongs to a different file — an upper-case extension is the
 * one that turns up. `cat` on Linux is exact, so that reads as a missing file
 * and the person is told the deliverable could not be retrieved.
 *
 * Returns undefined when nothing matches or a directory cannot be listed: the
 * caller then reports the original read failure, which is the more precise of
 * the two. THROWS when more than one entry differs only by case — which of
 * them was meant is not ours to guess, and sending the wrong file is worse
 * than sending none.
 */
async function resolveWorkspacePath(
  containerName: string,
  root: string,
  relPath: string,
  fetcher: FileFetcher,
): Promise<string | undefined> {
  const resolved: string[] = [];
  let dir = root;
  for (const segment of relPath.split("/").filter((s) => s !== "")) {
    let entries: string[];
    try {
      const listing = await fetcher(["docker", "exec", containerName, "ls", "-1", "--", dir], LIST_MAX_BYTES);
      entries = listing
        .toString("utf8")
        .split("\n")
        .filter((e) => e !== "");
    } catch {
      return undefined;
    }
    let match = entries.find((e) => e === segment);
    if (!match) {
      const lower = segment.toLowerCase();
      const candidates = entries.filter((e) => e.toLowerCase() === lower).sort();
      if (candidates.length === 0) return undefined;
      if (candidates.length > 1) {
        throw new Error(`ambiguous workspace path: ${relPath} matches ${candidates.join(" and ")}`);
      }
      match = candidates[0]!;
    }
    resolved.push(match);
    dir = `${dir}/${match}`;
  }
  return resolved.join("/");
}

/**
 * Read `relPath` from `containerName`'s workspace. Throws on an unsafe
 * path, a missing file (docker exec non-zero), or a file over the size
 * cap — the caller turns the throw into a user-facing message, never a
 * crash.
 *
 * The exact path is tried first, so a correct one still costs a single exec;
 * only a failed read pays for the case-insensitive resolution above, and the
 * returned `name` is then the file's real spelling rather than the one the
 * model wrote.
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
  // The console's limit, which the channel's own may undercut when the file is
  // sent.
  const maxBytes = opts?.maxBytes ?? fileLimitBytes();
  const fetcher = opts?.fetcher ?? realFetcher;
  // execFile (no shell) → the path is a single argv member, so spaces /
  // metacharacters can't inject. `--` stops cat option parsing.
  const read = async (rel: string): Promise<WorkspaceFile> => {
    const bytes = await fetcher(["docker", "exec", containerName, "cat", "--", `${root}/${rel}`], maxBytes);
    if (bytes.length > maxBytes) {
      throw new Error(`workspace file too large (${bytes.length} > ${maxBytes} bytes): ${rel}`);
    }
    return { name: basename(rel), bytes };
  };

  try {
    return await read(relPath);
  } catch (readErr) {
    if (readErr instanceof Error && /too large/.test(readErr.message)) throw readErr;
    const resolved = await resolveWorkspacePath(containerName, root, relPath, fetcher);
    // Nothing else to try: the path the model wrote is the only spelling the
    // workspace holds, so its own read error is the truthful one to report.
    if (resolved === undefined || resolved === relPath) throw readErr;
    return read(resolved);
  }
}

// The write side: an inbound chat attachment goes into the agent's workspace so
// the `message-attachment-receiver` skill (which routes files to the OCR /
// transcribe / docreader recipes) can read it. The bytes go on stdin to
// `docker exec -i <container> sh -c WORKSPACE_WRITE_SCRIPT cerase-write <root>
// <relPath>`, the command the control-plane's WorkspaceFileWriter runs. The
// container is the agent's own, so a symbolic link it made anywhere along the
// path would carry the write wherever the link points; the script refuses one.

/**
 * Run as `sh -c WORKSPACE_WRITE_SCRIPT cerase-write <workspace root> <relative path>`,
 * the same bytes as the control-plane's `WorkspaceFileWriter::SCRIPT`.
 *
 * It walks the path one folder at a time from the root, creating what is
 * missing and stopping at the first symbolic link. The bytes go to a
 * temporary file in the target folder, which is then renamed over the
 * target: a rename replaces a link planted after the check instead of
 * writing through it. Globbing is off, so no character of the path is
 * expanded. A refusal exits 3 with one line on stderr naming the segment.
 */
export const WORKSPACE_WRITE_SCRIPT = `set -euf
root=$1
rest=$2
dir=$root
while :; do
  case $rest in
    */*) seg=\${rest%%/*}; rest=\${rest#*/} ;;
    *) break ;;
  esac
  case $seg in ''|.) continue ;; esac
  dir=$dir/$seg
  if [ -L "$dir" ]; then printf 'refusing to write through a symbolic link: %s\\n' "$seg" >&2; exit 3; fi
  [ -d "$dir" ] || mkdir "$dir"
done
target=$dir/$rest
if [ -L "$target" ]; then printf 'refusing to write through a symbolic link: %s\\n' "$rest" >&2; exit 3; fi
if [ -d "$target" ]; then printf 'a folder already has this name: %s\\n' "$rest" >&2; exit 3; fi
tmp=$(mktemp "$dir/.cerase-write.XXXXXX")
if ! cat > "$tmp"; then rm -f "$tmp"; exit 1; fi
chmod 0644 "$tmp"
mv -f "$tmp" "$target"`;

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
    // A refusal exits without reading stdin, so the part of a file the pipe
    // could not hold fails here with EPIPE. Unhandled, that error would end
    // the bridge's process; the exit code and stderr report the refusal.
    let stdinError: Error | undefined;
    child.stdin.on("error", (err: Error) => {
      stdinError = err;
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code !== 0) reject(new Error(`workspace write failed (exit ${code}): ${stderr.trim()}`));
      else if (stdinError) reject(new Error(`workspace write failed: ${stdinError.message}`));
      else resolve();
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
 * Write `bytes` to `relPath` inside `containerName`'s workspace with
 * WORKSPACE_WRITE_SCRIPT, creating the folders along the path. The path reaches
 * the shell as an argument and never inside the script.
 *
 * Throws before touching docker on a path that is empty, absolute, climbs with
 * `..` or holds a single quote (the paths the control-plane's writer refuses
 * too), and on a file over the cap. Throws after it when the script refuses a
 * symbolic link along the path or a folder at the target's name, with the
 * script's line in the message. The caller turns a throw into a skipped
 * attachment, never a crash.
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
  const maxBytes = opts?.maxBytes ?? fileLimitBytes();
  const writer = opts?.writer ?? realWriter;
  if (bytes.length > maxBytes) {
    throw new Error(`workspace file too large (${bytes.length} > ${maxBytes} bytes): ${relPath}`);
  }
  const argv = [
    "docker",
    "exec",
    "-i",
    containerName,
    "sh",
    "-c",
    WORKSPACE_WRITE_SCRIPT,
    "cerase-write",
    root,
    relPath,
  ];
  await writer(argv, bytes);
}

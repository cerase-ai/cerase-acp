import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type FileFetcher,
  type FileWriter,
  readAgentWorkspaceFile,
  WORKSPACE_WRITE_SCRIPT,
  writeAgentWorkspaceFile,
} from "./workspace-files.js";

describe("readAgentWorkspaceFile", () => {
  it("runs docker exec cat against the container workspace and returns {name,bytes}", async () => {
    const fetcher = vi.fn(async () => Buffer.from("hello pdf"));
    const f = await readAgentWorkspaceFile("cerase-agent-1", "out/story.md", {
      fetcher,
      workspaceRoot: "/home/agent/cerase/workspace",
    });
    expect(f.name).toBe("story.md");
    expect(f.bytes.toString()).toBe("hello pdf");
    expect(fetcher).toHaveBeenCalledWith(
      ["docker", "exec", "cerase-agent-1", "cat", "--", "/home/agent/cerase/workspace/out/story.md"],
      expect.any(Number),
    );
  });

  it("rejects an unsafe (traversal) path before touching docker", async () => {
    const fetcher = vi.fn(async () => Buffer.from("x"));
    await expect(readAgentWorkspaceFile("c", "../etc/passwd", { fetcher })).rejects.toThrow(/unsafe/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("throws when the file exceeds the size cap", async () => {
    const fetcher = vi.fn(async () => Buffer.alloc(10));
    await expect(readAgentWorkspaceFile("c", "big.bin", { fetcher, maxBytes: 4 })).rejects.toThrow(/too large/);
  });
});

// The fetcher these cases use drops the `docker exec <container>` head of the
// argv and runs the rest as a real process against a real directory, so `cat`
// and `ls` behave as they do on the appliance and the filesystem's own answer
// is what the resolution is measured against. A fetcher that returns the same
// bytes for every argv cannot tell the two commands apart, and cannot tell the
// name a file has from the name the model wrote -- which is the shape of stub
// the case-sensitivity defect shipped behind.
const localFetcher: FileFetcher = (argv, maxBytes) =>
  new Promise<Buffer>((resolve, reject) => {
    const [bin, ...args] = argv.slice(3);
    execFile(bin!, args, { encoding: "buffer", maxBuffer: maxBytes + 1 }, (err: Error | null, stdout: Buffer) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

describe("readAgentWorkspaceFile — case resolution against a real workspace", () => {
  const workspace = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "cerase-ws-"));
    await mkdir(join(root, "outputs"));
    return root;
  };

  it("reads the file when only its extension casing differs, and reports its real name", async () => {
    const root = await workspace();
    await writeFile(join(root, "outputs", "falco-presentation.pdf"), "%PDF-1.7 three slides");

    const f = await readAgentWorkspaceFile("cerase-agent-1", "outputs/falco-presentation.PDF", {
      fetcher: localFetcher,
      workspaceRoot: root,
    });
    expect(f.name).toBe("falco-presentation.pdf");
    expect(f.bytes.toString()).toBe("%PDF-1.7 three slides");
  });

  it("refuses to guess when two files differ only by case, and names both", async () => {
    const root = await workspace();
    await writeFile(join(root, "outputs", "deck.pdf"), "lower");
    await writeFile(join(root, "outputs", "deck.PDF"), "upper");

    await expect(
      readAgentWorkspaceFile("cerase-agent-1", "outputs/Deck.pdf", { fetcher: localFetcher, workspaceRoot: root }),
    ).rejects.toThrow(/ambiguous.*deck\.PDF and deck\.pdf/);
  });

  it("resolves a mis-cased directory segment too", async () => {
    const root = await workspace();
    await writeFile(join(root, "outputs", "note.md"), "hi");

    const f = await readAgentWorkspaceFile("cerase-agent-1", "Outputs/NOTE.md", {
      fetcher: localFetcher,
      workspaceRoot: root,
    });
    expect(f.name).toBe("note.md");
    expect(f.bytes.toString()).toBe("hi");
  });

  it("still fails on a file that is simply not there, whatever its casing", async () => {
    const root = await workspace();
    await expect(
      readAgentWorkspaceFile("cerase-agent-1", "outputs/absent.pdf", { fetcher: localFetcher, workspaceRoot: root }),
    ).rejects.toThrow();
  });

  it("costs a single exec when the path is exact — no listing on the common path", async () => {
    const root = await workspace();
    await writeFile(join(root, "outputs", "ok.txt"), "fine");
    const counted = vi.fn(localFetcher);

    const f = await readAgentWorkspaceFile("cerase-agent-1", "outputs/ok.txt", {
      fetcher: counted,
      workspaceRoot: root,
    });
    expect(f.bytes.toString()).toBe("fine");
    expect(counted).toHaveBeenCalledTimes(1);
  });
});

describe("writeAgentWorkspaceFile", () => {
  it("runs the write script in the container with the root and path as arguments, and pipes the bytes", async () => {
    const writer = vi.fn<FileWriter>(async () => {});
    await writeAgentWorkspaceFile("cerase-agent-3", "uploads/7-0/voice.ogg", Buffer.from("OGG"), {
      writer,
      workspaceRoot: "/home/agent/cerase/workspace",
    });
    const [argv, bytes] = writer.mock.calls[0]!;
    expect(argv).toEqual([
      "docker",
      "exec",
      "-i",
      "cerase-agent-3",
      "sh",
      "-c",
      WORKSPACE_WRITE_SCRIPT,
      "cerase-write",
      "/home/agent/cerase/workspace",
      "uploads/7-0/voice.ogg",
    ]);
    expect(bytes.toString()).toBe("OGG");
  });

  it("rejects an unsafe (traversal) path before touching docker", async () => {
    const writer = vi.fn<FileWriter>(async () => {});
    await expect(writeAgentWorkspaceFile("c", "../etc/passwd", Buffer.from("x"), { writer })).rejects.toThrow(/unsafe/);
    expect(writer).not.toHaveBeenCalled();
  });

  it("throws when the file exceeds the size cap", async () => {
    const writer = vi.fn<FileWriter>(async () => {});
    await expect(
      writeAgentWorkspaceFile("c", "uploads/1-0/big.bin", Buffer.alloc(10), { writer, maxBytes: 4 }),
    ).rejects.toThrow(/too large/);
    expect(writer).not.toHaveBeenCalled();
  });
});

// The writer these cases use drops the `docker exec -i <container>` head of the
// argv and runs the rest as a real process with the bytes on stdin, so the
// script is measured against what a real filesystem does with a symbolic link.
// A writer that only records the argv cannot see where the bytes would land.
const localWriter: FileWriter = (argv, bytes) =>
  new Promise<void>((resolve, reject) => {
    const [bin, ...args] = argv.slice(4);
    const child = spawn(bin!, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    // A refused write exits without reading stdin; its exit code reports it.
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(`exit ${code}: ${stderr.trim()}`));
    });
    child.stdin.end(bytes);
  });

describe("writeAgentWorkspaceFile — symbolic links in a real workspace", () => {
  const dirs = async (): Promise<{ root: string; outside: string }> => ({
    root: await mkdtemp(join(tmpdir(), "cerase-ws-")),
    outside: await mkdtemp(join(tmpdir(), "cerase-outside-")),
  });

  it("refuses a link at uploads, writes nothing where it points, and names it", async () => {
    const { root, outside } = await dirs();
    await symlink(outside, join(root, "uploads"));

    await expect(
      writeAgentWorkspaceFile("cerase-agent-1", "uploads/7-0/voice.ogg", Buffer.from("OGG"), {
        writer: localWriter,
        workspaceRoot: root,
      }),
    ).rejects.toThrow(/symbolic link: uploads$/);
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses a target that is itself a link, and leaves the file it points to unchanged", async () => {
    const { root, outside } = await dirs();
    await mkdir(join(root, "uploads", "7-0"), { recursive: true });
    await writeFile(join(outside, "keep.txt"), "original");
    await symlink(join(outside, "keep.txt"), join(root, "uploads", "7-0", "voice.ogg"));

    await expect(
      writeAgentWorkspaceFile("cerase-agent-1", "uploads/7-0/voice.ogg", Buffer.from("OGG"), {
        writer: localWriter,
        workspaceRoot: root,
      }),
    ).rejects.toThrow(/symbolic link: voice\.ogg$/);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("original");
  });

  it("creates the missing folders and the file, readable by all, with no temporary file left beside it", async () => {
    const { root } = await dirs();

    await writeAgentWorkspaceFile("cerase-agent-1", "uploads/7-0/voice.ogg", Buffer.from("OGG bytes"), {
      writer: localWriter,
      workspaceRoot: root,
    });
    const file = join(root, "uploads", "7-0", "voice.ogg");
    expect(await readFile(file, "utf8")).toBe("OGG bytes");
    expect((await stat(file)).mode & 0o777).toBe(0o644);
    expect(await readdir(join(root, "uploads", "7-0"))).toEqual(["voice.ogg"]);
  });

  it("replaces the content of a regular file already at the path", async () => {
    const { root } = await dirs();
    await mkdir(join(root, "uploads", "7-0"), { recursive: true });
    await writeFile(join(root, "uploads", "7-0", "note.txt"), "old content");

    await writeAgentWorkspaceFile("cerase-agent-1", "uploads/7-0/note.txt", Buffer.from("new"), {
      writer: localWriter,
      workspaceRoot: root,
    });
    expect(await readFile(join(root, "uploads", "7-0", "note.txt"), "utf8")).toBe("new");
  });

  // The default writer, through a stand-in for the docker CLI on PATH. The CLI
  // spends a moment reaching the daemon before the script runs, and a refusal
  // then exits without reading what was sent; for a file larger than the pipe
  // holds, the unread rest fails with EPIPE on the bridge's side of the pipe.
  it("reports a refusal of a file larger than the pipe as a failed write, without an unhandled pipe error", async () => {
    const { root, outside } = await dirs();
    await symlink(outside, join(root, "uploads"));
    const bin = await mkdtemp(join(tmpdir(), "cerase-bin-"));
    await writeFile(join(bin, "docker"), '#!/bin/sh\nsleep 0.2\nshift 3\nexec "$@"\n', { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${path ?? ""}`;
    try {
      await expect(
        writeAgentWorkspaceFile("cerase-agent-1", "uploads/7-0/voice.ogg", Buffer.alloc(4 * 1024 * 1024), {
          workspaceRoot: root,
          maxBytes: 8 * 1024 * 1024,
        }),
      ).rejects.toThrow(/exit 3\): refusing to write through a symbolic link: uploads$/);
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
    expect(await readdir(outside)).toEqual([]);
  });
});

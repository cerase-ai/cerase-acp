import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type FileFetcher, readAgentWorkspaceFile, writeAgentWorkspaceFile } from "./workspace-files.js";

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
  it("runs docker exec -i sh -c 'mkdir -p … && cat > …' and pipes the bytes", async () => {
    const writer = vi.fn(async () => {});
    await writeAgentWorkspaceFile("cerase-agent-3", "uploads/7-0/voice.ogg", Buffer.from("OGG"), {
      writer,
      workspaceRoot: "/home/agent/cerase/workspace",
    });
    const [argv, bytes] = writer.mock.calls[0]!;
    expect((argv as string[]).slice(0, 5)).toEqual(["docker", "exec", "-i", "cerase-agent-3", "sh"]);
    expect((argv as string[])[6]).toBe(
      "mkdir -p '/home/agent/cerase/workspace/uploads/7-0' && cat > '/home/agent/cerase/workspace/uploads/7-0/voice.ogg'",
    );
    expect((bytes as Buffer).toString()).toBe("OGG");
  });

  it("rejects an unsafe (traversal) path before touching docker", async () => {
    const writer = vi.fn(async () => {});
    await expect(writeAgentWorkspaceFile("c", "../etc/passwd", Buffer.from("x"), { writer })).rejects.toThrow(/unsafe/);
    expect(writer).not.toHaveBeenCalled();
  });

  it("throws when the file exceeds the size cap", async () => {
    const writer = vi.fn(async () => {});
    await expect(
      writeAgentWorkspaceFile("c", "uploads/1-0/big.bin", Buffer.alloc(10), { writer, maxBytes: 4 }),
    ).rejects.toThrow(/too large/);
    expect(writer).not.toHaveBeenCalled();
  });
});

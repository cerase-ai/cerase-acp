import { describe, it, expect, vi } from "vitest";
import { readAgentWorkspaceFile, writeAgentWorkspaceFile } from "./workspace-files.js";

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
    await expect(
      readAgentWorkspaceFile("c", "big.bin", { fetcher, maxBytes: 4 }),
    ).rejects.toThrow(/too large/);
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
    await expect(
      writeAgentWorkspaceFile("c", "../etc/passwd", Buffer.from("x"), { writer }),
    ).rejects.toThrow(/unsafe/);
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

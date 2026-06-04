import { describe, it, expect, vi } from "vitest";
import { readAgentWorkspaceFile } from "./workspace-files.js";

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

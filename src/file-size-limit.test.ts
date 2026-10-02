// The console's file-size limit reaches the bridge and holds on both directions
// of a chat attachment.
//
// The control-plane writes the limit into agents.yaml as `max_file_mb`. The
// bridge refuses an inbound attachment over it from the size the channel
// reports, before downloading it, and tells the person the size, the limit and
// what to send instead; and it reads an outbound attachment up to the same
// limit rather than its own 8 MB.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractDiscordFiles, extractSlackFiles, extractTelegramFiles } from "./channel-attachments.js";
import { loadConfig } from "./config.js";
import { fileLimitBytes, fileLimitMb, setConsoleFileLimitMb } from "./file-limit.js";
import { buildOversizeNotice, effectiveMaxMb, ingestInboundAttachments } from "./inbound-attachments.js";
import { oversizeUploadNotice } from "./platform-notices.js";
import { type FileFetcher, type FileWriter, readAgentWorkspaceFile } from "./workspace-files.js";

const MB = 1024 * 1024;

afterEach(() => {
  setConsoleFileLimitMb(undefined);
});

function configWith(extra: string): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-file-limit-"));
  const path = join(dir, "agents.yaml");
  writeFileSync(path, `agents: []\nsession:\n  idle_timeout_minutes: 60\n  max_concurrent: 16\n${extra}`, "utf8");
  return path;
}

describe("the console's limit, from agents.yaml", () => {
  it("is taken from max_file_mb whenever the configuration is loaded", () => {
    const path = configWith("max_file_mb: 16\n");
    try {
      loadConfig(path, {});
      expect(fileLimitMb()).toBe(16);
      expect(fileLimitBytes()).toBe(16 * MB);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("falls back to 64 MB, the platform's ceiling, for a configuration without it", () => {
    const path = configWith("");
    try {
      setConsoleFileLimitMb(16);
      loadConfig(path, {});
      expect(fileLimitMb()).toBe(64);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("is what every channel's cap is taken from, under the channel's own ceiling", () => {
    setConsoleFileLimitMb(32);
    expect(effectiveMaxMb("workspace-chat")).toBe(32);
    expect(effectiveMaxMb("slack")).toBe(32);
    expect(effectiveMaxMb("discord")).toBe(25);
    expect(effectiveMaxMb("telegram")).toBe(20);
  });
});

describe("an attachment over the limit is refused before it is downloaded", () => {
  it("from the size the channel reports, without fetching a byte", async () => {
    const fetcher = vi.fn(async () => Buffer.from("ok"));
    const writer = vi.fn<FileWriter>(async () => {});
    const result = await ingestInboundAttachments(
      "cerase-agent-3",
      [
        { name: "Template che mi piace.pptx", url: "https://files.slack.com/big", sizeBytes: 70 * MB },
        { name: "note.txt", url: "https://files.slack.com/small", sizeBytes: 2 },
      ],
      "slack",
      { fetcher, writer, now: () => 5 },
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("https://files.slack.com/small", undefined);
    expect(result.rejected).toEqual([{ name: "Template che mi piace.pptx", sizeBytes: 70 * MB, reason: "oversize" }]);
    expect(result.stored).toEqual(["uploads/5-1/note.txt"]);
  });

  it("each channel's extractor carries the size it reports", () => {
    expect(extractDiscordFiles([{ name: "a.pdf", url: "https://cdn.discordapp.com/a.pdf", size: 1234 }])).toEqual([
      { name: "a.pdf", url: "https://cdn.discordapp.com/a.pdf", sizeBytes: 1234 },
    ]);
    expect(
      extractSlackFiles({ files: [{ name: "b.pdf", url_private_download: "https://files.slack.com/b", size: 99 }] }),
    ).toEqual([{ name: "b.pdf", url: "https://files.slack.com/b", sizeBytes: 99 }]);
    expect(extractTelegramFiles({ document: { file_id: "F1", file_name: "c.pdf", file_size: 7 } })).toEqual([
      { fileId: "F1", name: "c.pdf", sizeBytes: 7 },
    ]);
  });
});

describe("the notice names the size, the limit and what to send instead", () => {
  it("in the person's language", () => {
    const it_ = buildOversizeNotice(
      [{ name: "deck.pptx", sizeBytes: Math.round(70.2 * MB), reason: "oversize" }],
      "workspace-chat",
      "it",
    );
    expect(it_).toContain("«deck.pptx»");
    expect(it_).toContain("70,2 MB");
    expect(it_).toContain("64 MB");
    expect(it_).toContain("PDF");

    const en = oversizeUploadNotice([{ name: "deck.pptx", sizeBytes: Math.round(70.2 * MB) }], 64, "en");
    expect(en).toContain("70.2 MB");
    expect(en).toContain("64 MB");
    expect(en).toContain("split");
    expect(en).toContain("PDF");
  });

  it("names each file's size when several were refused", () => {
    const text = oversizeUploadNotice(
      [
        { name: "a.zip", sizeBytes: 99 * MB },
        { name: "b.mov", sizeBytes: 88 * MB },
      ],
      64,
      "en",
    );
    expect(text).toContain("«a.zip» (99.0 MB)");
    expect(text).toContain("«b.mov» (88.0 MB)");
    expect(text).toContain("64 MB");
  });
});

describe("an outbound attachment is read up to the console's limit", () => {
  it("a 10 MB file the assistant produced is read, where 8 MB used to be the bridge's own cap", async () => {
    const tenMb = Buffer.alloc(10 * MB, 1);
    const fetcher = vi.fn<FileFetcher>(async () => tenMb);

    const file = await readAgentWorkspaceFile("cerase-agent-3", "outputs/deck.pptx", { fetcher });

    expect(file.bytes.length).toBe(10 * MB);
    expect(fetcher.mock.calls[0]?.[1]).toBe(64 * MB);
  });

  it("follows a lower console limit", async () => {
    setConsoleFileLimitMb(4);
    const fetcher = vi.fn(async () => Buffer.alloc(5 * MB));

    await expect(readAgentWorkspaceFile("cerase-agent-3", "outputs/deck.pptx", { fetcher })).rejects.toThrow(
      /too large/,
    );
  });
});

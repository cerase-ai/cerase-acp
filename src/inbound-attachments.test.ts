import { describe, expect, it, vi } from "vitest";
import {
  ingestInboundAttachments,
  ingestInboundBuffers,
  prependUploadMarker,
  sanitizeFilename,
} from "./inbound-attachments.js";

describe("sanitizeFilename", () => {
  it("keeps a safe basename", () => {
    expect(sanitizeFilename("invoice.pdf")).toBe("invoice.pdf");
  });
  it("strips directory parts and unsafe chars", () => {
    expect(sanitizeFilename("../../etc/pa ss'wd")).toBe("pa_ss_wd");
    expect(sanitizeFilename("a/b/c.png")).toBe("c.png");
  });
  it("never returns empty", () => {
    expect(sanitizeFilename("")).toBe("file");
    expect(sanitizeFilename("...")).toBe("file");
  });
});

describe("prependUploadMarker", () => {
  it("prepends the marker the skill consumes", () => {
    expect(prependUploadMarker("ciao", ["uploads/1-0/a.pdf"])).toBe("[Uploaded files: uploads/1-0/a.pdf]\n\nciao");
  });
  it("returns text unchanged with no attachments", () => {
    expect(prependUploadMarker("ciao", [])).toBe("ciao");
  });
  it("stands alone for an attachment-only message", () => {
    expect(prependUploadMarker("", ["uploads/1-0/voice.ogg"])).toBe("[Uploaded files: uploads/1-0/voice.ogg]");
  });
});

describe("ingestInboundAttachments", () => {
  it("downloads each file, writes it under uploads/<ts>-<i>/, returns the paths", async () => {
    const fetcher = vi.fn(async (url: string) => Buffer.from(`bytes-of-${url}`));
    const writer = vi.fn(async () => {});
    const stored = await ingestInboundAttachments(
      "cerase-agent-3",
      [
        { name: "voice.ogg", url: "https://cdn/x/voice.ogg" },
        { name: "invoice.pdf", url: "https://cdn/x/invoice.pdf" },
      ],
      { fetcher, writer, now: () => 1000 },
    );

    expect(stored).toEqual(["uploads/1000-0/voice.ogg", "uploads/1000-1/invoice.pdf"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    // the writer got the docker write argv carrying the workspace path + bytes
    expect(writer).toHaveBeenCalledTimes(2);
    const [argv0, bytes0] = writer.mock.calls[0]!;
    expect(argv0).toEqual(expect.arrayContaining(["docker", "exec", "-i", "cerase-agent-3"]));
    expect((argv0 as string[]).join(" ")).toContain("uploads/1000-0/voice.ogg");
    expect((bytes0 as Buffer).toString()).toBe("bytes-of-https://cdn/x/voice.ogg");
  });

  it("skips an oversized file but keeps the rest", async () => {
    const fetcher = vi.fn(async (url: string) => (url.includes("big") ? Buffer.alloc(20) : Buffer.from("ok")));
    const writer = vi.fn(async () => {});
    const stored = await ingestInboundAttachments(
      "c",
      [
        { name: "big.bin", url: "https://cdn/big" },
        { name: "small.txt", url: "https://cdn/small" },
      ],
      { fetcher, writer, now: () => 7, maxBytes: 4 },
    );

    expect(stored).toEqual(["uploads/7-1/small.txt"]);
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it("skips a file whose fetch fails, never throwing", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("bad")) throw new Error("404");
      return Buffer.from("ok");
    });
    const writer = vi.fn(async () => {});
    const stored = await ingestInboundAttachments(
      "c",
      [
        { name: "bad.pdf", url: "https://cdn/bad" },
        { name: "good.pdf", url: "https://cdn/good" },
      ],
      { fetcher, writer, now: () => 9 },
    );

    expect(stored).toEqual(["uploads/9-1/good.pdf"]);
  });

  it("forwards auth headers to the fetcher (Slack url_private needs the bot token)", async () => {
    const fetcher = vi.fn(async () => Buffer.from("x"));
    const writer = vi.fn(async () => {});
    await ingestInboundAttachments("c", [{ name: "a.pdf", url: "https://slack/x" }], {
      fetcher,
      writer,
      now: () => 1,
      headers: { Authorization: "Bearer xoxb-1" },
    });
    expect(fetcher).toHaveBeenCalledWith("https://slack/x", { Authorization: "Bearer xoxb-1" });
  });
});

describe("ingestInboundBuffers", () => {
  it("stores pre-fetched bytes (Workspace Chat media) without a fetcher", async () => {
    const writer = vi.fn(async () => {});
    const stored = await ingestInboundBuffers("cerase-agent-2", [{ name: "doc.pdf", bytes: Buffer.from("PDF") }], {
      writer,
      now: () => 5,
    });
    expect(stored).toEqual(["uploads/5-0/doc.pdf"]);
    const [argv, bytes] = writer.mock.calls[0]!;
    expect((argv as string[]).join(" ")).toContain("uploads/5-0/doc.pdf");
    expect((bytes as Buffer).toString()).toBe("PDF");
  });
});

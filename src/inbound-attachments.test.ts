import { describe, expect, it, vi } from "vitest";
import {
  buildOversizeNotice,
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
    const result = await ingestInboundAttachments(
      "cerase-agent-3",
      [
        { name: "voice.ogg", url: "https://cdn/x/voice.ogg" },
        { name: "invoice.pdf", url: "https://cdn/x/invoice.pdf" },
      ],
      { fetcher, writer, now: () => 1000 },
    );

    expect(result.stored).toEqual(["uploads/1000-0/voice.ogg", "uploads/1000-1/invoice.pdf"]);
    expect(result.rejected).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    // the writer got the docker write argv carrying the workspace path + bytes
    expect(writer).toHaveBeenCalledTimes(2);
    const [argv0, bytes0] = writer.mock.calls[0]!;
    expect(argv0).toEqual(expect.arrayContaining(["docker", "exec", "-i", "cerase-agent-3"]));
    expect((argv0 as string[]).join(" ")).toContain("uploads/1000-0/voice.ogg");
    expect((bytes0 as Buffer).toString()).toBe("bytes-of-https://cdn/x/voice.ogg");
  });

  it("rejects an oversized file (fail-loud) but keeps the rest", async () => {
    const fetcher = vi.fn(async (url: string) => (url.includes("big") ? Buffer.alloc(20) : Buffer.from("ok")));
    const writer = vi.fn(async () => {});
    const result = await ingestInboundAttachments(
      "c",
      [
        { name: "big.bin", url: "https://cdn/big" },
        { name: "small.txt", url: "https://cdn/small" },
      ],
      { fetcher, writer, now: () => 7, maxBytes: 4 },
    );

    expect(result.stored).toEqual(["uploads/7-1/small.txt"]);
    // M-FILE-LIMITS-1: the over-cap file is surfaced, not silently dropped.
    expect(result.rejected).toEqual([{ name: "big.bin", sizeBytes: 20, reason: "oversize" }]);
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it("skips a file whose fetch fails, never throwing (and does NOT mark it rejected)", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("bad")) throw new Error("404");
      return Buffer.from("ok");
    });
    const writer = vi.fn(async () => {});
    const result = await ingestInboundAttachments(
      "c",
      [
        { name: "bad.pdf", url: "https://cdn/bad" },
        { name: "good.pdf", url: "https://cdn/good" },
      ],
      { fetcher, writer, now: () => 9 },
    );

    expect(result.stored).toEqual(["uploads/9-1/good.pdf"]);
    // A fetch/write failure is a silent skip, not an oversize rejection.
    expect(result.rejected).toEqual([]);
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
    const result = await ingestInboundBuffers("cerase-agent-2", [{ name: "doc.pdf", bytes: Buffer.from("PDF") }], {
      writer,
      now: () => 5,
    });
    expect(result.stored).toEqual(["uploads/5-0/doc.pdf"]);
    expect(result.rejected).toEqual([]);
    const [argv, bytes] = writer.mock.calls[0]!;
    expect((argv as string[]).join(" ")).toContain("uploads/5-0/doc.pdf");
    expect((bytes as Buffer).toString()).toBe("PDF");
  });
});

describe("buildOversizeNotice (M-FILE-LIMITS-1 fail-loud)", () => {
  it("returns undefined when nothing was rejected", () => {
    expect(buildOversizeNotice([])).toBeUndefined();
  });
  it("names the single oversize file and the MB cap (default 64)", () => {
    const msg = buildOversizeNotice([{ name: "huge.zip", sizeBytes: 99_000_000, reason: "oversize" }]);
    expect(msg).toBe("Il file «huge.zip» supera il limite di 64 MB e non è stato caricato.");
  });
  it("lists every oversize file when several were rejected", () => {
    const msg = buildOversizeNotice([
      { name: "a.zip", sizeBytes: 99_000_000, reason: "oversize" },
      { name: "b.mov", sizeBytes: 88_000_000, reason: "oversize" },
    ]);
    expect(msg).toBe("I file «a.zip», «b.mov» superano il limite di 64 MB e non sono stati caricati.");
  });
});

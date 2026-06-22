import { describe, expect, it } from "vitest";
import { extractSlackFiles, extractTelegramFiles, extractWorkspaceChatAttachments } from "./channel-attachments.js";

describe("extractTelegramFiles", () => {
  it("takes the largest photo size and defaults the name", () => {
    const refs = extractTelegramFiles({
      photo: [{ file_id: "small" }, { file_id: "big" }],
    });
    expect(refs).toEqual([{ fileId: "big", name: "photo.jpg" }]);
  });
  it("uses document file_name when present, falls back otherwise", () => {
    expect(extractTelegramFiles({ document: { file_id: "d", file_name: "report.pdf" } })).toEqual([
      { fileId: "d", name: "report.pdf" },
    ]);
    expect(extractTelegramFiles({ document: { file_id: "d" } })).toEqual([{ fileId: "d", name: "document" }]);
  });
  it("handles voice / audio / video", () => {
    expect(extractTelegramFiles({ voice: { file_id: "v" } })).toEqual([{ fileId: "v", name: "voice.ogg" }]);
    expect(extractTelegramFiles({ audio: { file_id: "a", file_name: "song.mp3" } })).toEqual([
      { fileId: "a", name: "song.mp3" },
    ]);
    expect(extractTelegramFiles({ video: { file_id: "vid" } })).toEqual([{ fileId: "vid", name: "video.mp4" }]);
  });
  it("returns [] for a text-only or empty message", () => {
    expect(extractTelegramFiles({ text: "ciao" })).toEqual([]);
    expect(extractTelegramFiles(undefined)).toEqual([]);
  });
});

describe("extractSlackFiles", () => {
  it("prefers url_private_download and keeps the name", () => {
    expect(
      extractSlackFiles({
        files: [{ name: "a.pdf", url_private_download: "https://x/dl", url_private: "https://x/p" }],
      }),
    ).toEqual([{ name: "a.pdf", url: "https://x/dl" }]);
  });
  it("falls back to url_private and a default name", () => {
    expect(extractSlackFiles({ files: [{ url_private: "https://x/p" }] })).toEqual([
      { name: "file", url: "https://x/p" },
    ]);
  });
  it("skips files without a private URL; [] when no files", () => {
    expect(extractSlackFiles({ files: [{ name: "x" }] })).toEqual([]);
    expect(extractSlackFiles({ text: "hi" })).toEqual([]);
  });
});

describe("extractWorkspaceChatAttachments", () => {
  it("pulls uploaded-content attachments by resourceName", () => {
    expect(
      extractWorkspaceChatAttachments({
        attachment: [{ contentName: "invoice.pdf", attachmentDataRef: { resourceName: "spaces/x/att/1" } }],
      }),
    ).toEqual([{ name: "invoice.pdf", resourceName: "spaces/x/att/1" }]);
  });
  it("skips drive-only attachments (no resourceName); [] when none", () => {
    expect(extractWorkspaceChatAttachments({ attachment: [{ driveDataRef: { driveFileId: "abc" } }] })).toEqual([]);
    expect(extractWorkspaceChatAttachments({ text: "hi" })).toEqual([]);
  });
});

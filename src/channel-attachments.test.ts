import { describe, expect, it } from "vitest";
import {
  extractSlackFiles,
  extractTelegramFiles,
  extractWorkspaceChatAttachments,
  type TelegramMessageLike,
  type WorkspaceChatMessageLike,
} from "./channel-attachments.js";

// A message as a platform delivers it carries fields the extractor does not
// read, such as its text. The types below add those fields to what each
// extractor reads, so a message is written out whole and still checked.
type SlackMessageLike = NonNullable<Parameters<typeof extractSlackFiles>[0]>;
type WorkspaceChatAttachment = NonNullable<WorkspaceChatMessageLike["attachment"]>[number];

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
    const textOnly: TelegramMessageLike & { text: string } = { text: "ciao" };
    expect(extractTelegramFiles(textOnly)).toEqual([]);
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
    const textOnly: SlackMessageLike & { text: string } = { text: "hi" };
    expect(extractSlackFiles(textOnly)).toEqual([]);
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
    const fromDrive: WorkspaceChatAttachment & { driveDataRef: { driveFileId: string } } = {
      driveDataRef: { driveFileId: "abc" },
    };
    expect(extractWorkspaceChatAttachments({ attachment: [fromDrive] })).toEqual([]);
    const textOnly: WorkspaceChatMessageLike & { text: string } = { text: "hi" };
    expect(extractWorkspaceChatAttachments(textOnly)).toEqual([]);
  });
});

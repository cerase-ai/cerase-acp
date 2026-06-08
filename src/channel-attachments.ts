// C4 — per-channel inbound-attachment extraction. Pure functions over each
// channel's raw message shape → a normalised list the adapter feeds to the
// shared ingest. Kept separate from the adapter glue so they're unit-tested
// without the channel SDKs.

/** A Telegram attachment reference: a file_id to resolve via getFileLink. */
export interface TelegramFileRef {
  fileId: string;
  name: string;
}

/**
 * Pull attachment file_ids out of a Telegram message. Handles the common DM
 * media kinds (document / photo / voice / audio / video); a photo is an array
 * of sizes — take the largest (last). Names fall back to a type default when
 * Telegram omits `file_name` (photos/voice always do).
 */
export function extractTelegramFiles(message: Record<string, any> | undefined): TelegramFileRef[] {
  if (!message) return [];
  const out: TelegramFileRef[] = [];

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    if (largest?.file_id) out.push({ fileId: largest.file_id, name: "photo.jpg" });
  }
  if (message.document?.file_id) {
    out.push({ fileId: message.document.file_id, name: message.document.file_name ?? "document" });
  }
  if (message.voice?.file_id) {
    out.push({ fileId: message.voice.file_id, name: "voice.ogg" });
  }
  if (message.audio?.file_id) {
    out.push({ fileId: message.audio.file_id, name: message.audio.file_name ?? "audio" });
  }
  if (message.video?.file_id) {
    out.push({ fileId: message.video.file_id, name: message.video.file_name ?? "video.mp4" });
  }
  return out;
}

/** A Slack file: a private URL that needs the bot token to download. */
export interface SlackFileRef {
  name: string;
  url: string;
}

/**
 * Pull downloadable files out of a Slack message event. Slack attaches them as
 * `files[]` with `url_private_download` (preferred) / `url_private`, both of
 * which require `Authorization: Bearer <bot token>`.
 */
export function extractSlackFiles(message: Record<string, any> | undefined): SlackFileRef[] {
  if (!message || !Array.isArray(message.files)) return [];
  const out: SlackFileRef[] = [];
  for (const f of message.files) {
    const url = f?.url_private_download ?? f?.url_private;
    if (typeof url === "string" && url !== "") {
      out.push({ name: typeof f.name === "string" && f.name !== "" ? f.name : "file", url });
    }
  }
  return out;
}

/** A Workspace Chat attachment: a Chat-API media resourceName to download. */
export interface WorkspaceChatAttachmentRef {
  name: string;
  resourceName: string;
}

/**
 * Pull uploaded-content attachments out of a Google Chat message. Each carries
 * `attachmentDataRef.resourceName`, downloaded via the Chat media API. Drive
 * attachments (driveDataRef, no resourceName) are skipped — they live in the
 * user's Drive, not fetchable as bot-uploaded media.
 */
export function extractWorkspaceChatAttachments(
  message: Record<string, any> | undefined,
): WorkspaceChatAttachmentRef[] {
  if (!message || !Array.isArray(message.attachment)) return [];
  const out: WorkspaceChatAttachmentRef[] = [];
  for (const a of message.attachment) {
    const resourceName = a?.attachmentDataRef?.resourceName;
    if (typeof resourceName === "string" && resourceName !== "") {
      out.push({ name: typeof a.contentName === "string" && a.contentName !== "" ? a.contentName : "file", resourceName });
    }
  }
  return out;
}

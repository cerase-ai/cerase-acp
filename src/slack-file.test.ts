import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAdapter, DeliveryResult, OutgoingFile } from "./chat-adapter.js";
import type { AgentConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";
import { createSlackAdapter } from "./slack-adapter.js";

// A file the assistant attaches goes out as a Slack upload in the direct
// message Slack opens for the person. Slack refuses a token that cannot upload
// (`missing_scope`, `not_allowed_token_type`) and a file past the workspace
// cap (`file_too_large`); each of those comes back as "send this one as a link"
// so the bridge can ask the control-plane for one.

const sdk = vi.hoisted(() => ({
  opens: [] as Array<Record<string, unknown>>,
  uploads: [] as Array<Record<string, unknown>>,
  openFail: undefined as unknown,
  uploadFail: undefined as unknown,
}));

vi.mock("@slack/bolt", () => {
  class App {
    client = {
      conversations: {
        open: async (args: Record<string, unknown>) => {
          if (sdk.openFail) throw sdk.openFail;
          sdk.opens.push(args);
          return { ok: true, channel: { id: "D0DIRECT" } };
        },
      },
      files: {
        uploadV2: async (args: Record<string, unknown>) => {
          if (sdk.uploadFail) throw sdk.uploadFail;
          sdk.uploads.push(args);
          return { ok: true };
        },
      },
    };
    message() {}
    action() {}
    error() {}
    async start() {}
    async stop() {}
  }
  return { App, LogLevel: { WARN: "warn" } };
});

const AGENT: AgentConfig = {
  id: "agent-1",
  channel: "slack",
  bot_token: "xoxb-not-a-real-token",
  slack_app_token: "xapp-not-a-real-token",
  allowed_users: ["U1"],
  cwd: "/home/agent/cerase/workspace",
  mode: "cerase",
  spawn: { command: "docker", args: [] },
};

const CAPTIONED: OutgoingFile = {
  name: "offerta.pdf",
  bytes: Buffer.from("%PDF-1.4 not a real pdf"),
  caption: "Ecco l'offerta.",
};

const BARE: OutgoingFile = { name: "offerta.pdf", bytes: Buffer.from("%PDF-1.4 not a real pdf") };

/** The failure arm that asks the bridge to send a link instead of the file. */
const linkInstead = (result: DeliveryResult) => (result as { linkInstead?: true }).linkInstead === true;

/** A Slack Web API refusal: an Error carrying the code in `data.error`. */
const slackError = (code: string) =>
  Object.assign(new Error(code), { code: "slack_webapi_platform_error", data: { ok: false, error: code } });

let adapter: ChatAdapter;

beforeEach(async () => {
  sdk.opens.length = 0;
  sdk.uploads.length = 0;
  sdk.openFail = undefined;
  sdk.uploadFail = undefined;
  adapter = createSlackAdapter(AGENT, {} as unknown as Dispatcher);
  await adapter.start();
  expect(adapter.sendFile).toBeTypeOf("function");
});

afterEach(async () => {
  await adapter.stop();
});

describe("the Slack adapter's sendFile", () => {
  it("opens the direct message, then uploads the file there with its caption", async () => {
    const result = await adapter.sendFile!("U1", CAPTIONED);

    expect(result).toEqual({ ok: true });
    expect(sdk.opens).toEqual([{ users: "U1" }]);
    expect(sdk.uploads).toEqual([
      {
        channel_id: "D0DIRECT",
        file: CAPTIONED.bytes,
        filename: "offerta.pdf",
        initial_comment: "Ecco l'offerta.",
      },
    ]);
  });

  it("uploads the file with no comment when it carries no caption", async () => {
    const result = await adapter.sendFile!("U1", BARE);

    expect(result).toEqual({ ok: true });
    expect(sdk.uploads).toHaveLength(1);
    expect(sdk.uploads[0]!.channel_id).toBe("D0DIRECT");
    expect(sdk.uploads[0]!.file).toEqual(BARE.bytes);
    expect(sdk.uploads[0]!.filename).toBe("offerta.pdf");
    expect(sdk.uploads[0]!.initial_comment).toBeUndefined();
  });

  it.each(["missing_scope", "not_allowed_token_type", "file_too_large"])(
    "answers linkInstead when Slack refuses the upload with %s",
    async (code) => {
      sdk.uploadFail = slackError(code);

      const result = await adapter.sendFile!("U1", BARE);

      expect(result.ok).toBe(false);
      expect(linkInstead(result)).toBe(true);
    },
  );

  it("answers linkInstead when opening the direct message is refused for a missing scope", async () => {
    sdk.openFail = slackError("missing_scope");

    const result = await adapter.sendFile!("U1", BARE);

    expect(result.ok).toBe(false);
    expect(linkInstead(result)).toBe(true);
  });

  it("returns another Slack error as a plain failure", async () => {
    sdk.uploadFail = new Error("rate limited");

    const result = await adapter.sendFile!("U1", BARE);

    expect(result.ok).toBe(false);
    expect(linkInstead(result)).toBe(false);
  });
});

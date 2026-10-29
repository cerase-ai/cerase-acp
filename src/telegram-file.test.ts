import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAdapter, DeliveryResult, OutgoingFile } from "./chat-adapter.js";
import type { AgentConfig } from "./config.js";
import type { Dispatcher } from "./dispatcher.js";
import { createTelegramAdapter } from "./telegram-adapter.js";

// A file the assistant attaches goes out as a Telegram document. Telegram caps
// documents at 50 MB and answers an over-limit upload with a 413, so both cases
// come back as "send this one as a link" rather than as a plain failure: the
// bridge then asks the control-plane for one instead of telling the person the
// file was lost.

const sdk = vi.hoisted(() => ({
  documents: [] as Array<{ userId: string; document: unknown; extra: unknown }>,
  sendDocumentFail: undefined as unknown,
}));

vi.mock("telegraf", () => {
  class Telegraf {
    telegram = {
      sendMessage: async () => ({}),
      sendChatAction: async () => true,
      sendDocument: async (userId: string, document: unknown, extra?: unknown) => {
        if (sdk.sendDocumentFail) throw sdk.sendDocumentFail;
        sdk.documents.push({ userId, document, extra });
        return { message_id: 1 };
      },
    };
    on() {}
    catch() {}
    launch(_opts: unknown, onLaunch?: () => void) {
      onLaunch?.();
      return new Promise<void>(() => {});
    }
    stop() {}
  }
  return { Telegraf };
});

const AGENT: AgentConfig = {
  id: "agent-1",
  channel: "telegram",
  bot_token: "123456:not-a-real-token",
  allowed_users: ["42"],
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

let adapter: ChatAdapter;

beforeEach(async () => {
  sdk.documents.length = 0;
  sdk.sendDocumentFail = undefined;
  adapter = createTelegramAdapter(AGENT, {} as unknown as Dispatcher);
  await adapter.start();
  expect(adapter.sendFile).toBeTypeOf("function");
});

afterEach(async () => {
  await adapter.stop();
});

describe("the Telegram adapter's sendFile", () => {
  it("sends the file as a document with the caption on it", async () => {
    const result = await adapter.sendFile!("42", CAPTIONED);

    expect(result).toEqual({ ok: true });
    expect(sdk.documents).toEqual([
      {
        userId: "42",
        document: { source: CAPTIONED.bytes, filename: "offerta.pdf" },
        extra: { caption: "Ecco l'offerta." },
      },
    ]);
  });

  it("sends the file bare when it carries no caption", async () => {
    const result = await adapter.sendFile!("42", BARE);

    expect(result).toEqual({ ok: true });
    expect(sdk.documents).toHaveLength(1);
    expect(sdk.documents[0]!.document).toEqual({ source: BARE.bytes, filename: "offerta.pdf" });
    expect(sdk.documents[0]!.extra).toBeUndefined();
  });

  it("answers linkInstead for a file over 50 MB without calling Telegram", async () => {
    const overLimit: OutgoingFile = {
      name: "grande.pdf",
      bytes: Buffer.allocUnsafe(50 * 1024 * 1024 + 1),
    };

    const result = await adapter.sendFile!("42", overLimit);

    expect(result.ok).toBe(false);
    expect(linkInstead(result)).toBe(true);
    expect(sdk.documents).toEqual([]);
  });

  it("answers linkInstead when Telegram refuses the upload with a 413", async () => {
    sdk.sendDocumentFail = Object.assign(new Error("413: Request Entity Too Large"), {
      code: 413,
      response: { ok: false, error_code: 413, description: "Request Entity Too Large" },
    });

    const result = await adapter.sendFile!("42", BARE);

    expect(result.ok).toBe(false);
    expect(linkInstead(result)).toBe(true);
  });

  it("returns another Telegram error as a plain failure", async () => {
    sdk.sendDocumentFail = new Error("network down");

    const result = await adapter.sendFile!("42", BARE);

    expect(result.ok).toBe(false);
    expect(linkInstead(result)).toBe(false);
  });
});

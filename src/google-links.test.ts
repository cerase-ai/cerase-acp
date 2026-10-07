// A Google link in a person's message reaches the assistant as a file it can
// open: the kind, the id written bare, and the recipe that reads it. The link
// of 6 October is the Sheet the assistant fetched as a web page and searched
// Drive for, while the Sheets recipe opened it at the first try given its id.

import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { BridgeConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import { googleFileLinks, googleLinksNote } from "./google-links.js";
import { SessionManager } from "./session-manager.js";
import { TurnMetaTracker } from "./turn-meta.js";

const FAKE_CHILD = fileURLToPath(new URL("./__tests__/fake-acp-child.mjs", import.meta.url));

const SHEET_ID = "1_X1um2lNDVdc-nYZlIFEGYCbt-OkGiSOkGpTyohAXFA";
const SHEET_LINK = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?usp=drivesdk`;

describe("the Google files a message links to", () => {
  it("the Sheet of 6 October is a spreadsheet with its id", () => {
    expect(googleFileLinks(`Ciao, mi leggi questo foglio? ${SHEET_LINK}`)).toEqual([
      { kind: "spreadsheet", id: SHEET_ID },
    ]);
  });

  it("are read from every form of link Docs, Sheets, Slides and Drive hand out", () => {
    const text = [
      "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-docA/edit?tab=t.0",
      "https://docs.google.com/document/u/1/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-docB/edit",
      "https://docs.google.com/spreadsheets/u/0/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-shtA/edit#gid=0",
      "https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-sldA/edit#slide=id.p",
      "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvW-fileA/view?usp=sharing",
      "https://drive.google.com/file/u/0/d/1AbCdEfGhIjKlMnOpQrStUvW-fileB/view",
      "https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrStUvW-fileC",
      "drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOpQrStUvW-fileD",
      "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvW-fldA?usp=sharing",
      "https://drive.google.com/drive/u/2/folders/1AbCdEfGhIjKlMnOpQrStUvW-fldB",
    ].join("\n");
    expect(googleFileLinks(text)).toEqual([
      { kind: "document", id: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-docA" },
      { kind: "document", id: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-docB" },
      { kind: "spreadsheet", id: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-shtA" },
      { kind: "presentation", id: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-sldA" },
      { kind: "file", id: "1AbCdEfGhIjKlMnOpQrStUvW-fileA" },
      { kind: "file", id: "1AbCdEfGhIjKlMnOpQrStUvW-fileB" },
      { kind: "file", id: "1AbCdEfGhIjKlMnOpQrStUvW-fileC" },
      { kind: "file", id: "1AbCdEfGhIjKlMnOpQrStUvW-fileD" },
      { kind: "folder", id: "1AbCdEfGhIjKlMnOpQrStUvW-fldA" },
      { kind: "folder", id: "1AbCdEfGhIjKlMnOpQrStUvW-fldB" },
    ]);
  });

  it("are read from the brackets Slack and Discord put around a link, once each, in the order they appear", () => {
    const slack = `guarda <${SHEET_LINK}|il foglio> e <https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvW-doc1/edit>`;
    expect(googleFileLinks(`${slack} e di nuovo ${SHEET_LINK}`)).toEqual([
      { kind: "spreadsheet", id: SHEET_ID },
      { kind: "document", id: "1AbCdEfGhIjKlMnOpQrStUvW-doc1" },
    ]);
  });

  it("leave out a document published to the web, another site's host and text that only looks like a path", () => {
    expect(
      googleFileLinks(
        [
          "https://docs.google.com/document/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz/pub",
          "https://mydocs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvW-x/edit",
          "https://docs.google.com/forms/d/1AbCdEfGhIjKlMnOpQrStUvW-form/viewform",
          "il foglio /spreadsheets/d/abc è quello del budget",
          "https://example.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvW-x",
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(googleLinksNote("ciao, come stai?")).toBeUndefined();
  });
});

describe("what the assistant is told", () => {
  it("for the Sheet of 6 October: the kind, the id outside any URL, and the recipe with its arguments", () => {
    const note = googleLinksNote(`Ciao Matilde, mi dai un'occhiata a questo foglio? ${SHEET_LINK}`);
    expect(note).toBe(
      [
        "[links_result: google files]",
        "The message below links to a Google file, and a link can reach you masked as a <url_…> placeholder, so here is what it names. Open it with the gateway's call_recipe, and never fetch a Google address as a web page, which Google refuses.",
        `1. a Google Sheets spreadsheet, id ${SHEET_ID}: call_recipe with recipe_name "google-workspace.getGoogleSheetContent" and args {"spreadsheetId":"${SHEET_ID}","range":"A1:Z200"}, which reads the first sheet; call_recipe with recipe_name "google-workspace.getSpreadsheetInfo" and args {"spreadsheetId":"${SHEET_ID}"} names its sheets, for a range such as "<sheet name>!A1:Z200".`,
        "These recipes are the Google Workspace connector's. If you have no such connector, say so to the person and ask them to send the file in the chat.",
      ].join("\n\n"),
    );
    // Nowhere is the id inside a URL, which the masking would hide whole.
    expect(note).not.toMatch(/https?:\/\//);
  });

  it("for several files: each one numbered, with the recipe and the argument that takes its id", () => {
    const note = googleLinksNote(
      [
        "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvW-doc1/edit",
        "https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOpQrStUvW-sld1/edit",
        "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvW-pdf1/view",
        "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvW-fld1",
      ].join(" "),
    )!;
    expect(note).toContain("The message below links to 4 Google files");
    expect(note).toContain(
      '1. a Google Docs document, id 1AbCdEfGhIjKlMnOpQrStUvW-doc1: call_recipe with recipe_name "google-workspace.readGoogleDoc" and args {"documentId":"1AbCdEfGhIjKlMnOpQrStUvW-doc1"}.',
    );
    expect(note).toContain(
      '2. a Google Slides presentation, id 1AbCdEfGhIjKlMnOpQrStUvW-sld1: call_recipe with recipe_name "google-workspace.getGoogleSlidesContent" and args {"presentationId":"1AbCdEfGhIjKlMnOpQrStUvW-sld1"}.',
    );
    expect(note).toContain(
      '3. a file on Google Drive, id 1AbCdEfGhIjKlMnOpQrStUvW-pdf1: call_recipe with recipe_name "google-workspace.downloadFile" and args {"fileId":"1AbCdEfGhIjKlMnOpQrStUvW-pdf1","localPath":"<a name for the file>"}',
    );
    expect(note).toContain(
      '4. a Google Drive folder, id 1AbCdEfGhIjKlMnOpQrStUvW-fld1: call_recipe with recipe_name "google-workspace.listFolder" and args {"folderId":"1AbCdEfGhIjKlMnOpQrStUvW-fld1"}',
    );
  });

  // A link passed where a tool takes the folder's id names no folder Drive
  // knows, so the upload into it fails.
  it("for a Drive folder: the recipe that lists it, the one that uploads into it by its bare id, and that no tool takes the link", () => {
    const folderId = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
    const note = googleLinksNote(
      `Mi carichi il verbale in questa cartella? https://drive.google.com/drive/folders/${folderId}?usp=sharing`,
    )!;
    expect(note).toContain(
      `1. a Google Drive folder, id ${folderId}: call_recipe with recipe_name "google-workspace.listFolder" and args {"folderId":"${folderId}"}, which lists what it holds; call_recipe with recipe_name "google-workspace.uploadFile" and args {"localPath":"<the path of the file in your workspace>","parentFolderId":"${folderId}"} puts that file into it. Every Google Workspace tool takes the bare id, never the link.`,
    );
    expect(note).not.toMatch(/https?:\/\/|usp=sharing/);
  });
});

// Through the real dispatcher and session manager to the ACP child, which
// answers with the blocks of the prompt it received and the audience of each.
describe("a message with a Google link, sent to the assistant", () => {
  let mgr: SessionManager | undefined;

  afterEach(async () => {
    if (mgr) await mgr.shutdown();
    mgr = undefined;
  });

  function bridge() {
    const config: BridgeConfig = {
      agents: [
        {
          id: "doc-qa",
          channel: "discord",
          cwd: "/home/agent/cerase/workspace",
          mode: "cerase",
          bot_token: "irrelevant",
          allowed_users: ["111"],
          // One chunk, so the echo comes back as it was sent.
          spawn: { command: "env", args: ["--", "FAKE_ECHO_PROMPT=blocks", "FAKE_CHUNKS=1", "node", FAKE_CHILD] },
        },
      ],
      session: { idle_timeout_minutes: 60, max_concurrent: 16 },
    };
    mgr = new SessionManager(config);
    const sent: string[] = [];
    const d = new Dispatcher({
      config,
      sessionManager: mgr,
      turnMeta: new TurnMetaTracker(),
      resolveSendTarget: () => async (text) => {
        sent.push(text);
        return { ok: true };
      },
    });
    return { d, echoed: () => sent.map((s) => s.replace(/ ⏎$/u, "")).join("") };
  }

  it("carries the note for the assistant alone, ahead of the person's words, and none without a link", async () => {
    const { d, echoed } = bridge();
    const message = `Ciao Matilde, mi dai un'occhiata a questo foglio? ${SHEET_LINK}`;
    expect(await d.handleMessage("doc-qa", "111", message)).toEqual({ ok: true });
    const blocks = echoed().split("\n\neveryone: ");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe(`assistant: ${googleLinksNote(message)}`);
    expect(blocks[1]).toMatch(/^\[turn_meta: /);
    expect(blocks[1]!.endsWith(message)).toBe(true);

    const plain = bridge();
    expect(await plain.d.handleMessage("doc-qa", "111", "ciao, come stai?")).toEqual({ ok: true });
    expect(plain.echoed()).toMatch(/^everyone: \[turn_meta: /);
    expect(plain.echoed()).not.toContain("assistant:");
  });
});

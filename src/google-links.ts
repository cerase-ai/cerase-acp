// A Google Docs, Sheets, Slides or Drive link in a person's message, told to the
// assistant as a file it can open.
//
// The privacy layer at the model boundary masks every URL in a message as a
// `<url_…>` placeholder, so the assistant never sees the link, nor the file id
// inside it. Left to itself it fetched a shared Sheet as a web page, which
// Google answers with a sign-in, and searched Drive by words, while the Sheets
// tool opens the file at the first attempt given its id.
//
// So the bridge reads the links itself and tells the assistant, in a block for
// the assistant alone ahead of the person's message (PromptOptions.context),
// each file's kind, its id written bare, outside any URL the masking would
// hide, and the recipe of the Google Workspace connector that opens it through
// the gateway's call_recipe, with the argument that takes the id. A folder also
// gets the recipe that uploads a file from the assistant's workspace into it.
// The recipes and argument names are the connector's own, at the version the
// catalogue installs (@piotr-agier/google-drive-mcp 2.5.0).

import { bridgePromptLine } from "./bridge-prompt.js";

export type GoogleFileKind = "document" | "spreadsheet" | "presentation" | "file" | "folder";

export interface GoogleFileLink {
  kind: GoogleFileKind;
  id: string;
}

// Drive ids are URL-safe base64. The shortest a real file or folder has is
// well above ten characters; a shorter run is not an id. A link to a document
// published to the web (`/d/e/<id>`) carries an id of another kind, which no
// API takes, and is left alone because `e` is not ten characters long.
const ID = "[A-Za-z0-9_-]{10,}";
// The account index a link carries when its author is signed in to several.
const ACCOUNT = "(?:/u/\\d+)?";
// Not inside a longer host name, such as another site's `mydocs.google.com`.
const START = "(?<![\\w.-])(?:https?://)?";

const PATTERNS: { kind: GoogleFileKind | "docs"; pattern: RegExp }[] = [
  {
    kind: "docs",
    pattern: new RegExp(
      `${START}docs\\.google\\.com${ACCOUNT}/(document|spreadsheets|presentation)${ACCOUNT}/d/(${ID})`,
      "g",
    ),
  },
  { kind: "file", pattern: new RegExp(`${START}drive\\.google\\.com${ACCOUNT}/file${ACCOUNT}/d/(${ID})`, "g") },
  {
    kind: "file",
    pattern: new RegExp(`${START}drive\\.google\\.com${ACCOUNT}/(?:open|uc)\\?(?:[^\\s#>|]*&)?id=(${ID})`, "g"),
  },
  {
    kind: "folder",
    pattern: new RegExp(`${START}drive\\.google\\.com(?:/drive)?${ACCOUNT}/folders/(${ID})`, "g"),
  },
];

const DOCS_KIND: Record<string, GoogleFileKind> = {
  document: "document",
  spreadsheets: "spreadsheet",
  presentation: "presentation",
};

/**
 * The Google files `text` links to, in the order the links appear, each once
 * however often it is linked.
 */
export function googleFileLinks(text: string): GoogleFileLink[] {
  const found: { at: number; link: GoogleFileLink }[] = [];
  for (const { kind, pattern } of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const link: GoogleFileLink =
        kind === "docs" ? { kind: DOCS_KIND[match[1]!]!, id: match[2]! } : { kind, id: match[1]! };
      found.push({ at: match.index, link });
    }
  }
  found.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  return found.flatMap(({ link }) => {
    if (seen.has(link.id)) return [];
    seen.add(link.id);
    return [link];
  });
}

/** How the assistant opens one file: what it is, and the call that reads it. */
function howToOpen(link: GoogleFileLink): string {
  const { id } = link;
  const call = (recipe: string, args: Record<string, string>) =>
    `call_recipe with recipe_name "google-workspace.${recipe}" and args ${JSON.stringify(args)}`;
  switch (link.kind) {
    case "document":
      return `a Google Docs document, id ${id}: ${call("readGoogleDoc", { documentId: id })}.`;
    case "spreadsheet":
      return (
        `a Google Sheets spreadsheet, id ${id}: ${call("getGoogleSheetContent", { spreadsheetId: id, range: "A1:Z200" })}` +
        `, which reads the first sheet; ${call("getSpreadsheetInfo", { spreadsheetId: id })} names its sheets, for a range such as "<sheet name>!A1:Z200".`
      );
    case "presentation":
      return `a Google Slides presentation, id ${id}: ${call("getGoogleSlidesContent", { presentationId: id })}.`;
    case "file":
      return (
        `a file on Google Drive, id ${id}: ${call("downloadFile", { fileId: id, localPath: "<a name for the file>" })}` +
        ", which saves it in your workspace and answers with the path to read."
      );
    case "folder":
      return (
        `a Google Drive folder, id ${id}: ${call("listFolder", { folderId: id })}, which lists what it holds; ` +
        `${call("uploadFile", { localPath: "<the path of the file in your workspace>", parentFolderId: id })} puts that file into it. ` +
        "Every Google Workspace tool takes the bare id, never the link."
      );
  }
}

/**
 * What the assistant is told about the Google files a person's message links
 * to, or undefined when it links to none.
 */
export function googleLinksNote(text: string): string | undefined {
  const links = googleFileLinks(text);
  if (links.length === 0) return undefined;
  const one = links.length === 1;
  return [
    bridgePromptLine("links", "google files"),
    `${one ? "The message below links to a Google file" : `The message below links to ${links.length} Google files`}, and a link can reach you masked as a <url_…> placeholder, so here is what ${one ? "it names" : "they name, in the order they appear"}. Open ${one ? "it" : "each"} with the gateway's call_recipe, and never fetch a Google address as a web page, which Google refuses.`,
    links.map((link, i) => `${i + 1}. ${howToOpen(link)}`).join("\n"),
    "These recipes are the Google Workspace connector's. If you have no such connector, say so to the person and ask them to send the file in the chat.",
  ].join("\n\n");
}

import { describe, expect, it } from "vitest";
import { fileLinkNotice } from "./platform-notices.js";

// A file the channel cannot carry reaches the person as a link. The notice
// names the file, gives the address and says the day the link expires, in the
// language of the conversation and with that language's month name.

const FILE = "offerta.pdf";
const URL = `https://box.example.test/f/${"a".repeat(64)}`;
const EXPIRES = "2026-11-05T09:00:00+01:00";

describe("fileLinkNotice", () => {
  it("writes the file, the link and the expiry date in Italian", () => {
    expect(fileLinkNotice(FILE, URL, EXPIRES, "it")).toBe(
      `Puoi scaricare offerta.pdf da questo link, che scade il 5 novembre: ${URL}`,
    );
  });

  it("writes the file, the link and the expiry date in English", () => {
    expect(fileLinkNotice(FILE, URL, EXPIRES, "en")).toBe(
      `You can download offerta.pdf from this link, which expires on 5 November: ${URL}`,
    );
  });

  it("writes the file, the link and the expiry date in Spanish", () => {
    expect(fileLinkNotice(FILE, URL, EXPIRES, "es")).toBe(
      `Puedes descargar offerta.pdf desde este enlace, que caduca el 5 de noviembre: ${URL}`,
    );
  });

  it("writes the file, the link and the expiry date in French", () => {
    expect(fileLinkNotice(FILE, URL, EXPIRES, "fr")).toBe(
      `Tu peux télécharger offerta.pdf depuis ce lien, qui expire le 5 novembre : ${URL}`,
    );
  });

  it("falls back to Italian when the conversation's language is unknown", () => {
    expect(fileLinkNotice(FILE, URL, EXPIRES, "unknown")).toBe(fileLinkNotice(FILE, URL, EXPIRES, "it"));
  });
});

// A bridge restart must not forget the language a conversation is held in.
//
// The language lived only in the tracker's Map, so the first message after a
// release took its own words' language: an Italian message carrying «le» was
// tagged French. These tests keep the language in the state directory, beside
// the messages and replies the bridge already keeps there, and make sure the
// restart reads it back.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectLanguage, TurnMetaTracker } from "./turn-meta.js";

const T0 = 1_700_000_000_000;
const STEP = 60_000;

const ITALIAN = "Ciao, mi prepari il riepilogo di oggi?";
const ITALIAN_FOLLOW_UP = "Grazie, va bene così.";
const FRENCH = "Bonjour, je voudrais la liste des tâches pour cette semaine.";
const FRENCH_FOLLOW_UP = "Merci, je voudrais aussi les détails du projet.";
const ENGLISH = "Hello, can you help me summarise the document?";
const ENGLISH_FOLLOW_UP = "Thanks, that is everything for now.";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turn-meta-restart-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tagOf(block: string): string | undefined {
  return block.match(/\blang=([a-z]+)\b/)?.[1];
}

describe("the language a conversation is held in across a bridge restart", () => {
  it("does not read an Italian message as French because it contains «le»", () => {
    expect(
      detectLanguage("Elenca le mie attività aperte e le scadenze con la competenza tasks-and-deadlines."),
    ).not.toBe("fr");
    expect(detectLanguage("Le ho scritto ieri e le ho mandato il file.")).toBe("it");
  });

  it("keeps an Italian conversation Italian after a restart", async () => {
    const before = new TurnMetaTracker({ stateDir: dir });
    expect(tagOf(await before.prefixWithContext("agent-1", "seat:f", ITALIAN, { now: T0 }))).toBe("it");
    expect(tagOf(await before.prefixWithContext("agent-1", "seat:f", ITALIAN_FOLLOW_UP, { now: T0 + STEP }))).toBe(
      "it",
    );

    const after = new TurnMetaTracker({ stateDir: dir });
    // The language is known before the restarted bridge has seen a turn.
    expect(after.languageFor("agent-1", "seat:f")).toBe("it");

    // A first turn pointing elsewhere does not move a known conversation.
    expect(tagOf(await after.prefixWithContext("agent-1", "seat:f", FRENCH, { now: T0 + 2 * STEP }))).toBe("unknown");
    expect(tagOf(await after.prefixWithContext("agent-1", "seat:f", FRENCH_FOLLOW_UP, { now: T0 + 3 * STEP }))).toBe(
      "fr",
    );
  });

  it("keeps nothing without a state directory", async () => {
    const before = new TurnMetaTracker();
    await before.prefixWithContext("agent-1", "seat:f", ITALIAN, { now: T0 });
    await before.prefixWithContext("agent-1", "seat:f", ITALIAN_FOLLOW_UP, { now: T0 + STEP });

    const after = new TurnMetaTracker();
    expect(after.languageFor("agent-1", "seat:f")).toBe("unknown");
    // A conversation with no known language still takes its first message's.
    expect(tagOf(await after.prefixWithContext("agent-1", "seat:f", FRENCH, { now: T0 + 2 * STEP }))).toBe("fr");
  });

  it("keeps each conversation's language independently across a restart", async () => {
    const before = new TurnMetaTracker({ stateDir: dir });
    await before.prefixWithContext("agent-1", "seat:f", ITALIAN, { now: T0 });
    await before.prefixWithContext("agent-1", "seat:f", ITALIAN_FOLLOW_UP, { now: T0 + STEP });
    await before.prefixWithContext("agent-2", "seat:g", ENGLISH, { now: T0 + 2 * STEP });
    await before.prefixWithContext("agent-2", "seat:g", ENGLISH_FOLLOW_UP, { now: T0 + 3 * STEP });

    const after = new TurnMetaTracker({ stateDir: dir });
    expect(after.languageFor("agent-1", "seat:f")).toBe("it");
    expect(after.languageFor("agent-2", "seat:g")).toBe("en");
  });

  it("writes only the language, to a file the bridge alone can read", async () => {
    const tracker = new TurnMetaTracker({ stateDir: dir });
    await tracker.prefixWithContext("agent-1", "seat:f", ITALIAN, { now: T0 });
    await tracker.prefixWithContext("agent-1", "seat:f", ITALIAN_FOLLOW_UP, { now: T0 + STEP });

    const files = readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((path) => statSync(path).isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const content = readFileSync(file, "utf8");
      expect(content).not.toContain("riepilogo");
      expect(content).not.toContain("Grazie");
    }
  });

  it("starts empty when the kept file cannot be read, and still answers the turn", async () => {
    const before = new TurnMetaTracker({ stateDir: dir });
    await before.prefixWithContext("agent-1", "seat:f", ITALIAN, { now: T0 });

    for (const name of readdirSync(dir)) {
      writeFileSync(join(dir, name), "not json");
    }

    const after = new TurnMetaTracker({ stateDir: dir });
    expect(tagOf(await after.prefixWithContext("agent-1", "seat:f", ITALIAN, { now: T0 + STEP }))).toBe("it");
    expect(after.languageFor("agent-9", "seat:z")).toBe("unknown");
  });
});

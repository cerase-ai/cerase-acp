import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordSpecOutcome, specRow, specTest } from "./spec-rows.js";

const FIXTURE_ID = "ACP-FIXTURE-001";
const FIXTURE_FILE = "src/test-support/spec-rows.ts";

const savedEnv = new Map<string, string | undefined>();
const temporaryDirs: string[] = [];

function rememberEnv(name: string): void {
  savedEnv.set(name, process.env[name]);
}

function restoreEnv(name: string): void {
  const value = savedEnv.get(name);
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function temporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cerase-spec-"));
  temporaryDirs.push(dir);
  return dir;
}

function fingerprint(when: string, expect: string): string {
  return createHash("sha256").update(`${when}\t${expect}`, "utf8").digest("hex").slice(0, 16);
}

beforeEach(() => {
  rememberEnv("CERASE_SPEC_ROOT");
  rememberEnv("CERASE_SPEC_LEDGER");
});

afterEach(() => {
  restoreEnv("CERASE_SPEC_ROOT");
  restoreEnv("CERASE_SPEC_LEDGER");
  for (const dir of temporaryDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("specRow", () => {
  it("loads the fixture row and the area that declares it", () => {
    const row = specRow(FIXTURE_ID);

    expect(row.id).toBe(FIXTURE_ID);
    expect(row.when).toBe('a row whose when quotes "alpha" and "beta"');
    expect(row.expect).toBe("the reader hands back alpha and beta");
    expect(row.file).toBe(FIXTURE_FILE);
    expect(row.dec).toBe("");
    expect(row.area).toContain("fixtures");
  });

  it("returns the double-quoted segments of a column in order", () => {
    expect(specRow(FIXTURE_ID).quoted("when")).toEqual(["alpha", "beta"]);
  });

  it("fails when the specs directory is missing under CERASE_SPEC_ROOT", () => {
    process.env.CERASE_SPEC_ROOT = temporaryDir();

    expect(() => specRow(FIXTURE_ID)).toThrow();
  });

  it("fails for an ID that no area file declares", () => {
    expect(() => specRow("ACP-NOT-A-ROW")).toThrow();
  });
});

specTest(FIXTURE_ID, "renders the quoted words the row expects", (row) => {
  const rendered = `the reader hands back ${row.quoted("when").join(" and ")}`;

  expect(rendered).toBe(row.expect);
});

describe("spec ledger", () => {
  it("writes one documented line for a passing body and one for a failing body", () => {
    const ledger = join(temporaryDir(), "ledger.tsv");
    process.env.CERASE_SPEC_LEDGER = ledger;
    const row = specRow(FIXTURE_ID);
    const expectedFingerprint = fingerprint(row.when, row.expect);

    recordSpecOutcome(row, "pass", "a passing body");
    recordSpecOutcome(row, "fail", "a failing body");

    const lines = readFileSync(ledger, "utf8")
      .split("\n")
      .filter((line) => line !== "");

    expect(lines).toEqual([
      `${FIXTURE_ID}\tpass\ta passing body\t${expectedFingerprint}`,
      `${FIXTURE_ID}\tfail\ta failing body\t${expectedFingerprint}`,
    ]);
  });
});

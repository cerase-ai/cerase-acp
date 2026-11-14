import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertionResults,
  assertionTitles,
  fingerprint,
  INNER_RUN_TIMEOUT,
  ledgerById,
  parseInnerReport,
  readLedger,
  removeTemporaryDirs,
  runInnerSpecTests,
  temporaryDir,
} from "./inner-spec-run.js";
import { recordSpecOutcome, specRow, specTest } from "./spec-rows.js";

const FIXTURE_ID = "ACP-FIXTURE-001";
const FIXTURE_FILE = "src/test-support/spec-rows.ts";

const savedEnv = new Map<string, string | undefined>();

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

beforeEach(() => {
  rememberEnv("CERASE_SPEC_ROOT");
  rememberEnv("CERASE_SPEC_LEDGER");
});

afterEach(() => {
  restoreEnv("CERASE_SPEC_ROOT");
  restoreEnv("CERASE_SPEC_LEDGER");
  removeTemporaryDirs();
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

function fixtureSpecRoot(): string {
  const root = temporaryDir();
  mkdirSync(join(root, "specs"), { recursive: true });
  writeFileSync(join(root, "specs", "INDEX.tsv"), "path\tscope\trows\nspecs/fixtures.tsv\tfixtures\t2\n", "utf8");
  writeFileSync(
    join(root, "specs", "fixtures.tsv"),
    [
      "id\twhen\texpect\tfile\tdec",
      'ACP-FIXTURE-901\ta row that quotes "one"\tthe case reads one\tsrc/test-support/spec-rows.ts\t',
      'ACP-FIXTURE-902\ta row that quotes "two"\tthe case reads two\tsrc/test-support/spec-rows.ts\t',
      "",
    ].join("\n"),
    "utf8",
  );
  return root;
}

describe("specTest.each", () => {
  it(
    "registers one test per ID and records one passing ledger line per row",
    () => {
      const root = fixtureSpecRoot();
      const ledger = join(temporaryDir(), "ledger.tsv");
      const source = [
        'import { expect } from "vitest";',
        'import { specTest } from "./test-support/spec-rows.js";',
        "",
        'specTest.each(["ACP-FIXTURE-901", "ACP-FIXTURE-902"])("reads the case %s", (row) => {',
        '  expect(`the case reads ${row.quoted("when")[0]}`).toBe(row.expect);',
        "});",
      ].join("\n");

      const run = runInnerSpecTests(source, root, ledger);

      expect(run.status).toBe(0);
      const report = parseInnerReport(run.output);
      expect(report.numTotalTests).toBe(2);
      const titles = assertionTitles(report);
      expect(titles).toHaveLength(2);
      for (const id of ["ACP-FIXTURE-901", "ACP-FIXTURE-902"]) {
        expect(titles.some((title) => title.includes(id) && title.trimEnd().endsWith("[spec]"))).toBe(true);
      }

      const lines = readLedger(ledger);
      expect(lines).toHaveLength(2);
      const byId = ledgerById(lines);
      expect(byId.get("ACP-FIXTURE-901")?.outcome).toBe("pass");
      expect(byId.get("ACP-FIXTURE-901")?.fingerprint).toBe(
        fingerprint('a row that quotes "one"', "the case reads one"),
      );
      expect(byId.get("ACP-FIXTURE-902")?.outcome).toBe("pass");
      expect(byId.get("ACP-FIXTURE-902")?.fingerprint).toBe(
        fingerprint('a row that quotes "two"', "the case reads two"),
      );
    },
    INNER_RUN_TIMEOUT,
  );

  it(
    "records a passing line for the row that passes and a failing line for the row that fails",
    () => {
      const root = fixtureSpecRoot();
      const ledger = join(temporaryDir(), "ledger.tsv");
      const source = [
        'import { expect } from "vitest";',
        'import { specTest } from "./test-support/spec-rows.js";',
        "",
        'specTest.each(["ACP-FIXTURE-901", "ACP-FIXTURE-902"])("reads the case %s", (row) => {',
        '  expect(row.id).not.toBe("ACP-FIXTURE-902");',
        "});",
      ].join("\n");

      const run = runInnerSpecTests(source, root, ledger);

      expect(run.status).not.toBe(0);
      const results = assertionResults(parseInnerReport(run.output));
      expect(results.find((result) => result.title.includes("ACP-FIXTURE-901"))?.status).toBe("passed");
      expect(results.find((result) => result.title.includes("ACP-FIXTURE-902"))?.status).toBe("failed");

      const lines = readLedger(ledger);
      expect(lines).toHaveLength(2);
      const byId = ledgerById(lines);
      expect(byId.get("ACP-FIXTURE-901")?.outcome).toBe("pass");
      expect(byId.get("ACP-FIXTURE-902")?.outcome).toBe("fail");
    },
    INNER_RUN_TIMEOUT,
  );

  it(
    "passes the declared row and fails for an ID that no area declares",
    () => {
      const root = fixtureSpecRoot();
      const ledger = join(temporaryDir(), "ledger.tsv");
      const unknownId = "ACP-NOT-A-ROW";
      const source = [
        'import { expect } from "vitest";',
        'import { specTest } from "./test-support/spec-rows.js";',
        "",
        `specTest.each(["ACP-FIXTURE-901", "${unknownId}"])("reads the case %s", (row) => {`,
        '  expect(row.id).toBe("ACP-FIXTURE-901");',
        "});",
      ].join("\n");

      const run = runInnerSpecTests(source, root, ledger);

      expect(run.status).not.toBe(0);
      expect(run.output).toContain(unknownId);
      const results = assertionResults(parseInnerReport(run.output));
      expect(results.find((result) => result.title.includes(unknownId))?.status).toBe("failed");

      const byId = ledgerById(readLedger(ledger));
      expect(byId.get("ACP-FIXTURE-901")?.outcome).toBe("pass");
    },
    INNER_RUN_TIMEOUT,
  );

  it(
    "still registers one test per ID when the name has no placeholder",
    () => {
      const root = fixtureSpecRoot();
      const ledger = join(temporaryDir(), "ledger.tsv");
      const source = [
        'import { expect } from "vitest";',
        'import { specTest } from "./test-support/spec-rows.js";',
        "",
        'specTest.each(["ACP-FIXTURE-901", "ACP-FIXTURE-902"])("reads the case", (row) => {',
        "  expect(row.id).toBeDefined();",
        "});",
      ].join("\n");

      const run = runInnerSpecTests(source, root, ledger);

      expect(run.status).toBe(0);
      const report = parseInnerReport(run.output);
      expect(report.numTotalTests).toBe(2);
      const titles = assertionTitles(report);
      expect(titles).toHaveLength(2);
      for (const id of ["ACP-FIXTURE-901", "ACP-FIXTURE-902"]) {
        expect(titles.some((title) => title.includes(id) && title.trimEnd().endsWith("[spec]"))).toBe(true);
      }
    },
    INNER_RUN_TIMEOUT,
  );
});

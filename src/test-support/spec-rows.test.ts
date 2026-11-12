import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INNER_RUN_TIMEOUT = 60_000;

interface InnerAssertionResult {
  title: string;
  status: string;
}

interface InnerTestResult {
  assertionResults: InnerAssertionResult[];
}

interface InnerReport {
  numTotalTests: number;
  testResults: InnerTestResult[];
}

interface InnerRun {
  status: number | null;
  output: string;
}

interface LedgerLine {
  id: string;
  outcome: string;
  testName: string;
  fingerprint: string;
}

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

function runInnerSpecTests(source: string, root: string, ledger: string): InnerRun {
  const testFile = join(REPOSITORY_ROOT, "src", `__spec-each-${randomUUID()}.test.ts`);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("VITEST")) {
      delete env[name];
    }
  }
  env.CERASE_SPEC_ROOT = root;
  env.CERASE_SPEC_LEDGER = ledger;

  try {
    writeFileSync(testFile, source, "utf8");
    const result = spawnSync(
      join(REPOSITORY_ROOT, "node_modules", ".bin", "vitest"),
      ["run", testFile, "--reporter=json"],
      {
        cwd: REPOSITORY_ROOT,
        env,
        encoding: "utf8",
        timeout: INNER_RUN_TIMEOUT - 5_000,
      },
    );
    return {
      status: result.status,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  } finally {
    rmSync(testFile, { force: true });
  }
}

function parseInnerReport(output: string): InnerReport {
  return JSON.parse(output) as InnerReport;
}

function readLedger(path: string): LedgerLine[] {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  return content
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [id = "", outcome = "", testName = "", lineFingerprint = ""] = line.split("\t");
      return { id, outcome, testName, fingerprint: lineFingerprint };
    });
}

function ledgerById(lines: LedgerLine[]): Map<string, LedgerLine> {
  return new Map(lines.map((line) => [line.id, line]));
}

function assertionResults(report: InnerReport): InnerAssertionResult[] {
  return report.testResults.flatMap((result) => result.assertionResults);
}

function assertionTitles(report: InnerReport): string[] {
  return assertionResults(report).map((assertion) => assertion.title);
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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertionResults,
  fingerprint,
  INNER_RUN_TIMEOUT,
  ledgerById,
  parseInnerReport,
  REPOSITORY_ROOT,
  readLedger,
  removeTemporaryDirs,
  runInnerSpecTests,
  temporaryDir,
} from "./inner-spec-run.js";

const FIXTURE_DIR = join(REPOSITORY_ROOT, "src", "test-support", "fixtures");
const FIXTURE_AREA = join(FIXTURE_DIR, "table-case.tsv");
const INNER_SOURCE = join(FIXTURE_DIR, "table-case.inner.ts");

interface FixtureRow {
  id: string;
  when: string;
  expect: string;
}

afterEach(() => {
  removeTemporaryDirs();
});

// The proof reads its rows and its inner source from the fixture, so editing
// the fixture is the only way to change what the proof checks.
function fixtureRows(): FixtureRow[] {
  const lines = readFileSync(FIXTURE_AREA, "utf8")
    .split("\n")
    .filter((line) => line !== "");
  const header = (lines.shift() ?? "").split("\t");
  const id = header.indexOf("id");
  const when = header.indexOf("when");
  const expect = header.indexOf("expect");

  return lines.map((line) => {
    const fields = line.split("\t");
    return {
      id: fields[id] ?? "",
      when: fields[when] ?? "",
      expect: fields[expect] ?? "",
    };
  });
}

function tableSpecRoot(areaContent: string): string {
  const root = temporaryDir();
  mkdirSync(join(root, "specs"), { recursive: true });
  writeFileSync(join(root, "specs", "INDEX.tsv"), "path\tscope\trows\nspecs/table-case.tsv\tfixtures\t3\n", "utf8");
  writeFileSync(join(root, "specs", "table-case.tsv"), areaContent, "utf8");
  return root;
}

function rewriteExpect(id: string, expect: string): string {
  const content = readFileSync(FIXTURE_AREA, "utf8");
  const lines = content.split("\n");
  const header = (lines[0] ?? "").split("\t");
  const expectIndex = header.indexOf("expect");

  return lines
    .map((line) => {
      if (!line.startsWith(`${id}\t`)) {
        return line;
      }
      const fields = line.split("\t");
      fields[expectIndex] = expect;
      return fields.join("\t");
    })
    .join("\n");
}

describe("a changed expect", () => {
  it(
    "runs every fixture row green before any expect is changed",
    () => {
      const rows = fixtureRows();
      const root = tableSpecRoot(readFileSync(FIXTURE_AREA, "utf8"));
      const ledger = join(temporaryDir(), "ledger.tsv");
      const source = readFileSync(INNER_SOURCE, "utf8");

      const run = runInnerSpecTests(source, root, ledger);

      expect(run.status).toBe(0);
      const report = parseInnerReport(run.output);
      expect(report.numTotalTests).toBe(3);
      const results = assertionResults(report);
      expect(results).toHaveLength(3);
      expect(results.every((result) => result.status === "passed")).toBe(true);
      for (const row of rows) {
        expect(results.some((result) => result.title.includes(row.id))).toBe(true);
      }

      const lines = readLedger(ledger);
      expect(lines).toHaveLength(3);
      const byId = ledgerById(lines);
      for (const row of rows) {
        expect(byId.get(row.id)?.outcome).toBe("pass");
        expect(byId.get(row.id)?.fingerprint).toBe(fingerprint(row.when, row.expect));
      }
    },
    INNER_RUN_TIMEOUT,
  );

  it(
    "reds only the row whose expect changed in the copy",
    () => {
      const changed = 'the reader answers "wrong"';
      const rows = fixtureRows();
      const changedRow = rows.find((row) => row.id === "ACP-TABLE-FIXTURE-002");
      if (changedRow === undefined) {
        throw new Error("the fixture is missing ACP-TABLE-FIXTURE-002");
      }
      const root = tableSpecRoot(rewriteExpect("ACP-TABLE-FIXTURE-002", changed));
      const ledger = join(temporaryDir(), "ledger.tsv");
      const source = readFileSync(INNER_SOURCE, "utf8");

      const run = runInnerSpecTests(source, root, ledger);

      expect(run.status).not.toBe(0);
      const results = assertionResults(parseInnerReport(run.output));
      const failed = results.find((result) => result.title.includes("ACP-TABLE-FIXTURE-002"));
      expect(failed?.status).toBe("failed");
      expect(failed?.title).toContain("ACP-TABLE-FIXTURE-002");
      expect(results.find((result) => result.title.includes("ACP-TABLE-FIXTURE-001"))?.status).toBe("passed");
      expect(results.find((result) => result.title.includes("ACP-TABLE-FIXTURE-003"))?.status).toBe("passed");

      const lines = readLedger(ledger);
      expect(lines).toHaveLength(3);
      const byId = ledgerById(lines);
      expect(byId.get("ACP-TABLE-FIXTURE-001")?.outcome).toBe("pass");
      expect(byId.get("ACP-TABLE-FIXTURE-002")?.outcome).toBe("fail");
      expect(byId.get("ACP-TABLE-FIXTURE-003")?.outcome).toBe("pass");
      expect(byId.get("ACP-TABLE-FIXTURE-002")?.fingerprint).toBe(fingerprint(changedRow.when, changed));
    },
    INNER_RUN_TIMEOUT,
  );
});

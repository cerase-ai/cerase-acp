import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// src/test-support/inner-spec-run.ts → repo root is two dirs up.
export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const INNER_RUN_TIMEOUT = 60_000;

export interface InnerAssertionResult {
  title: string;
  status: string;
}

export interface InnerTestResult {
  assertionResults: InnerAssertionResult[];
}

export interface InnerReport {
  numTotalTests: number;
  testResults: InnerTestResult[];
}

export interface InnerRun {
  status: number | null;
  output: string;
}

export interface LedgerLine {
  id: string;
  outcome: string;
  testName: string;
  fingerprint: string;
}

const temporaryDirs: string[] = [];

export function temporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cerase-spec-"));
  temporaryDirs.push(dir);
  return dir;
}

export function removeTemporaryDirs(): void {
  for (const dir of temporaryDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function fingerprint(when: string, expect: string): string {
  return createHash("sha256").update(`${when}\t${expect}`, "utf8").digest("hex").slice(0, 16);
}

export function runInnerSpecTests(source: string, root: string, ledger: string): InnerRun {
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

export function parseInnerReport(output: string): InnerReport {
  return JSON.parse(output) as InnerReport;
}

export function readLedger(path: string): LedgerLine[] {
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

export function ledgerById(lines: LedgerLine[]): Map<string, LedgerLine> {
  return new Map(lines.map((line) => [line.id, line]));
}

export function assertionResults(report: InnerReport): InnerAssertionResult[] {
  return report.testResults.flatMap((result) => result.assertionResults);
}

export function assertionTitles(report: InnerReport): string[] {
  return assertionResults(report).map((assertion) => assertion.title);
}

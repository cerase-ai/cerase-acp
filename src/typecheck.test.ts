import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// src/typecheck.test.ts → repo root is one dir up.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const TSC = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
const CONFIG = "tsconfig.test.json";

// Every file a test run loads that the build's tsconfig leaves out: the tests
// and the fakes they share.
const testFiles = readdirSync(join(repoRoot, "src"), { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".test.ts") || (f.startsWith("__tests__") && f.endsWith(".ts")))
  .map((f) => resolve(repoRoot, "src", f));

// `npm run build` checks the types of what ships and nothing else, and vitest
// runs a test without checking its types, so a fake that stopped matching what
// it stands in for passed both. The check runs here, inside the suite, so the
// suite and CI's run of it fail on a type error in a test as the build fails on
// one in the code.
describe(`the type check over ${CONFIG}`, () => {
  let status: number | null = null;
  let listed = new Set<string>();
  let errors: string[] = [];

  beforeAll(() => {
    const run = spawnSync(process.execPath, [TSC, "-p", CONFIG, "--listFiles"], { cwd: repoRoot, encoding: "utf8" });
    status = run.status;
    const lines = `${run.stdout}\n${run.stderr}`.split("\n");
    errors = lines.filter((l) => /error TS\d+/.test(l));
    listed = new Set(lines.filter((l) => l.startsWith("/")).map((l) => resolve(l.trim())));
  }, 120_000);

  it("finds no type error in the code or in the tests", () => {
    expect(errors, errors.join("\n")).toEqual([]);
    expect(status).toBe(0);
  });

  it("reads every test file and every shared fake under src", () => {
    expect(testFiles.length).toBeGreaterThan(50);
    expect(testFiles.filter((f) => !listed.has(f))).toEqual([]);
  });
});

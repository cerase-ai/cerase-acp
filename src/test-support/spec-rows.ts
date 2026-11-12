import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

export type SpecOutcome = "pass" | "fail" | "skip";

export interface SpecRow {
  id: string;
  when: string;
  expect: string;
  file: string;
  dec: string;
  area: string;
  quoted(column: string): string[];
}

interface Table {
  header: string[];
  rows: Record<string, string>[];
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function parseTsv(path: string): Table {
  const lines = readFileSync(path, "utf8").replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const headerLine = lines.shift();
  if (headerLine === undefined) {
    throw new Error(`${path}: no header`);
  }

  const header = headerLine.split("\t");
  const rows = lines.map((line) => {
    const fields = line.split("\t");
    const row: Record<string, string> = {};
    header.forEach((name, index) => {
      row[name] = fields[index] ?? "";
    });
    return row;
  });

  return { header, rows };
}

function requireColumn(table: Table, name: string, path: string): void {
  if (!table.header.includes(name)) {
    throw new Error(`${path}: no ${name} column`);
  }
}

function toSpecRow(row: Record<string, string>, area: string): SpecRow {
  const values: Record<string, string> = {
    id: row.id ?? "",
    when: row.when ?? "",
    expect: row.expect ?? "",
    file: row.file ?? "",
    dec: row.dec ?? "",
  };

  const read = (column: string): string => {
    const value = values[column];
    if (value === undefined) {
      throw new Error(`row: no ${column} column`);
    }
    return value;
  };

  return {
    id: read("id"),
    when: read("when"),
    expect: read("expect"),
    file: read("file"),
    dec: read("dec"),
    area,
    quoted(column: string): string[] {
      return [...read(column).matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? "");
    },
  };
}

export function specRow(id: string): SpecRow {
  const root = process.env.CERASE_SPEC_ROOT ? resolve(process.env.CERASE_SPEC_ROOT) : repositoryRoot;
  const indexPath = resolve(root, "specs", "INDEX.tsv");
  const index = parseTsv(indexPath);
  requireColumn(index, "path", indexPath);

  for (const entry of index.rows) {
    const areaPath = entry.path ?? "";
    if (areaPath === "") {
      continue;
    }

    const areaFile = resolve(root, areaPath);
    const area = parseTsv(areaFile);
    for (const name of ["id", "when", "expect", "file"]) {
      requireColumn(area, name, areaFile);
    }

    const found = area.rows.find((row) => row.id === id);
    if (found !== undefined) {
      return toSpecRow(found, areaPath);
    }
  }

  throw new Error(`spec row ${id} is declared in no area under ${root}`);
}

export function recordSpecOutcome(row: SpecRow, outcome: SpecOutcome, testId: string): void {
  const ledger = process.env.CERASE_SPEC_LEDGER;
  if (!ledger) {
    return;
  }

  const fingerprint = createHash("sha256").update(`${row.when}\t${row.expect}`, "utf8").digest("hex").slice(0, 16);
  appendFileSync(ledger, `${row.id}\t${outcome}\t${testId}\t${fingerprint}\n`, "utf8");
}

type SpecBody = (row: SpecRow) => void | Promise<void>;

function runSpecTest(id: string, title: string, body: SpecBody): void {
  it(title, async () => {
    const row = specRow(id);
    let outcome: SpecOutcome = "fail";
    try {
      await body(row);
      outcome = "pass";
    } finally {
      recordSpecOutcome(row, outcome, expect.getState().currentTestName ?? title);
    }
  });
}

function eachTitle(name: string, id: string): string {
  const rendered = name.includes("%s") ? name.replaceAll("%s", id) : `${name} ${id}`;
  return `${rendered} [spec]`;
}

function each(ids: readonly string[]): (name: string, body: SpecBody) => void {
  return (name, body) => {
    for (const id of ids) {
      runSpecTest(id, eachTitle(name, id), body);
    }
  };
}

export const specTest = Object.assign(
  function specTest(id: string, name: string, body: SpecBody): void {
    runSpecTest(id, `${name} [spec]`, body);
  },
  { each },
);

# Spec rows

A test can cite a row of `specs/INDEX.tsv` by its ID. The reader in
`src/test-support/spec-rows.ts` looks the ID up in the area files the index
names, and hands back the row's `when`, `expect`, `file`, `dec` and the area
file that declared it. `quoted(column)` returns the double-quoted segments of a
column, in order.

```ts
import { expect } from "vitest";
import { specTest } from "../test-support/spec-rows.js";

specTest("ACP-FIXTURE-001", "renders the quoted words", (row) => {
  const rendered = `the reader hands back ${row.quoted("when").join(" and ")}`;
  expect(rendered).toBe(row.expect);
});
```

`specTest` registers an ordinary vitest test whose name ends in `[spec]`, so
`npx vitest run -t "\[spec\]"` selects exactly the tests that cite a row. The
test fails when the row's ID is unknown or when the specs tree cannot be read;
it is never skipped, because a suite that skips every row looks as green as one
that ran them.

## The ledger

When `CERASE_SPEC_LEDGER` names a file, each citing test appends exactly one
line after it has run:

```
<id>	<pass|fail|skip>	<test id>	<fingerprint>
```

The test id is vitest's full name for the test. The fingerprint is the first 16
hex characters of the SHA-256 of `when + "\t" + expect`, so a row edited without
re-running its test is caught. The line is written on failure as well as on
success.

## Running conformance

```
npm run conformance
```

That runs the citing tests with a fresh ledger, then runs
`python3 scripts/conformance.py --ledger <file> --root . --all` through
`scripts/conformance.sh`. The judge fails when any row in `specs/` was not
executed by a passing test, so a new row is not done until a test cites it.

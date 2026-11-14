import { expect } from "vitest";
import { specTest } from "./test-support/spec-rows.js";

// The run copies this file to src/, where that import resolves; it lives here
// so the suite never collects it and the proof writes no row inline.
specTest.each(["ACP-TABLE-FIXTURE-001", "ACP-TABLE-FIXTURE-002", "ACP-TABLE-FIXTURE-003"])(
  "reads %s backwards",
  (row) => {
    const reversed = [...(row.quoted("when")[0] ?? "")].reverse().join("");
    expect(`the reader answers "${reversed}"`).toBe(row.expect);
  },
);

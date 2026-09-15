import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// src/tooling-pin.test.ts → repo root is one dir up.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const PIN = "scripts/TOOLING.sha256";
const CHECK = `sha256sum --check ${PIN}`;

type Step = { id?: string; run?: string; if?: string; env?: Record<string, string>; "continue-on-error"?: boolean };

// Read from the pin itself, so a row added to it is covered on the day it lands.
const pinnedScripts = [
  ...readFileSync(join(repoRoot, PIN), "utf8").matchAll(/^[0-9a-f]{64}\s+(scripts\/[A-Za-z0-9_.-]+\.sh)$/gm),
].map((m) => m[1] as string);

const ci = parse(readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8"));
const jobs = Object.entries(ci.jobs as Record<string, { steps?: Step[] }>);

// The guard scripts are cerase-core's, copied here and pinned. Without a check
// against the pin, a copy edited in this repo decides the push while
// cerase-core's decides every other repo, and nothing in this repo's CI says so.
describe("the vendored tooling is checked against its pin", () => {
  it("reads the scripts it covers from the pin", () => {
    expect(pinnedScripts).toContain("scripts/docs-parity.sh");
  });

  it("is checked in every job that runs a pinned script, before the first one runs", () => {
    const running = jobs.filter(([, job]) =>
      (job.steps ?? []).some((s) => pinnedScripts.some((p) => String(s.run ?? "").includes(p))),
    );
    expect(running.length, "no job runs a pinned script, so this case would compare nothing").toBeGreaterThan(0);

    for (const [name, job] of running) {
      const runs = (job.steps ?? []).map((s) => String(s.run ?? ""));
      const firstScript = runs.findIndex((r) => pinnedScripts.some((p) => r.includes(p)));
      const check = runs.findIndex((r) => r.includes(CHECK));
      expect(check, `job ${name} runs the vendored scripts without checking them against ${PIN}`).toBeGreaterThan(-1);
      expect(check, `job ${name} runs a pinned script before its copy is checked against the pin`).toBeLessThan(
        firstScript,
      );
    }
  });

  it("fails the job when the check fails, even though every guard step here continues on error", () => {
    // A step that continues on error refuses nothing by itself. The job fails
    // only when a later step that always runs reads its outcome and exits on
    // it, which is what the verdict step does for every other guard.
    for (const [name, job] of jobs) {
      const steps = job.steps ?? [];
      const at = steps.findIndex((s) => String(s.run ?? "").includes(CHECK));
      if (at < 0) continue;
      const step = steps[at] as Step;
      if (!step["continue-on-error"]) continue;

      expect(step.id, `job ${name}: the pin check has no id, so no step can read its outcome`).toBeTruthy();
      const verdict = steps.slice(at + 1).find((s) => {
        const key = Object.entries(s.env ?? {}).find(([, v]) => v.includes(`steps.${step.id}.outcome`))?.[0];
        return String(s.if ?? "").includes("always()") && key && String(s.run ?? "").includes(`"$${key}" = failure`);
      });
      expect(verdict, `job ${name}: nothing fails the job on the pin check's outcome`).toBeDefined();
    }
  });
});

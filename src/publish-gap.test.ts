import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// src/publish-gap.test.ts → repo root is one dir up.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workflow = (name: string) => parse(readFileSync(join(repoRoot, ".github", "workflows", name), "utf8"));

const autoMerge = workflow("dependabot-auto-merge.yml");
const publish = workflow("docker-publish.yml");
const selfHeal = workflow("publish-self-heal.yml");

// A push made with `secrets.GITHUB_TOKEN` raises no events, so the squash-merge
// `dependabot-auto-merge.yml` queues lands on main and starts nothing. That
// left a dependency security bump on main with zero workflow runs for two
// days, while `:latest` went on serving the code from before it.
//
// The repair is `publish-self-heal.yml`, and these three files only work
// TOGETHER: the auto-merge opens the gap, the publish must be dispatchable, and
// the self-heal must be triggered by something the suppressed merge cannot
// silence. Each assertion below is one of those three halves, so removing any
// one of them reds here rather than going quiet for two days.
describe("an auto-merged head still reaches the registry", () => {
  it("the auto-merge still merges with GITHUB_TOKEN, which is what opens the gap", () => {
    // Not a requirement — a PREMISE. If this ever stops being true (a PAT, a
    // GitHub App) the merge raises events again and the self-heal is dead
    // weight, so this failing is the signal to reconsider the other two.
    const steps = autoMerge.jobs.merge.steps as Array<Record<string, unknown>>;
    const merging = steps.find((s) => String(s.run ?? "").includes("gh pr merge"));
    expect(merging).toBeDefined();
    expect(JSON.stringify(merging)).toContain("secrets.GITHUB_TOKEN");
  });

  it("the publish can be started by hand, because that is the only way back", () => {
    // `workflow_dispatch` is the documented exception to the suppression rule:
    // the token may START a run even though it may not cause one. Without this
    // key the self-heal has nothing to call and the gap cannot be closed
    // without a human.
    expect(publish.on).toHaveProperty("workflow_dispatch");
  });

  it("the self-heal is triggered by a schedule, not by the merge", () => {
    // The trap this test exists for. Reacting to the merge — a job on
    // `pull_request_target: closed` — is suppressed by the same rule that
    // suppressed the push, so it would look correct and never run. The trigger
    // has to come from outside the merge.
    expect(selfHeal.on).toHaveProperty("schedule");
    expect(JSON.stringify(selfHeal.on)).not.toContain("pull_request");
  });

  it("the self-heal may dispatch, and starts the publish it discovered", () => {
    expect(selfHeal.permissions?.actions).toBe("write");

    const steps = selfHeal.jobs.heal.steps as Array<Record<string, unknown>>;
    const run = steps.map((s) => String(s.run ?? "")).join("\n");
    // By workflow PATH, never by display name: a filter on the name goes blind
    // the day the workflow is renamed, and goes blind silently.
    expect(run).toContain("actions/workflows/${wf}/runs");
    expect(run).toContain("gh workflow run");
  });

  it("is the file cerase-core vendors, not a copy this repo maintains", () => {
    // NOTE: this repo had a bespoke self-heal that asked the REGISTRY, which is a
    // stronger question than the shared one asks. It was replaced anyway: six
    // repos need this behaviour, and two implementations of one question is the
    // defect the vendoring exists to remove. The shared file is pinned by
    // `scripts/TOOLING.sha256` and CI reds when this copy drifts from
    // cerase-core's.
    const pin = readFileSync(join(repoRoot, "scripts", "TOOLING.sha256"), "utf8");
    expect(pin).toContain(".github/workflows/publish-self-heal.yml");
  });

  it("tells a run list it could not read apart from an empty one", () => {
    // Three outcomes, not two. Collapsing them dispatches a full image build
    // every morning for a repository whose API is merely refusing us.
    const steps = selfHeal.jobs.heal.steps as Array<Record<string, unknown>>;
    const run = steps.map((s) => String(s.run ?? "")).join("\n");
    expect(run).toContain("unreadable");
    expect(run).toContain("not-expected");
  });

  it("does not retry a FAILED publish, only a missing or cancelled one", () => {
    // A red publish is a fix to push, not a dice roll, and re-dispatching it
    // every morning burns a runner to reproduce the same red. A CANCELLED run
    // is the opposite: nothing else ever retries a superseded one.
    const steps = selfHeal.jobs.heal.steps as Array<Record<string, unknown>>;
    const dispatch = steps.find((s) => String(s.name ?? "") === "Publish it");
    expect(String(dispatch?.if)).toContain("missing");
    expect(String(dispatch?.if)).toContain("cancelled");
    expect(String(dispatch?.if)).not.toContain("ran");
  });

  it("reads the publish's own path filter rather than restating it", () => {
    // The publish here ignores the devplan directory, and something else in five
    // of the six repos that carry this file, so a copy of the patterns would go
    // stale in most of them. Without the walk-back a planning-only head would
    // be dispatched every morning: it correctly has no run, for ever.
    const ignored = publish.on.push["paths-ignore"] as string[];
    expect(ignored).toContain("devplan/**");

    const steps = selfHeal.jobs.heal.steps as Array<Record<string, unknown>>;
    const run = steps.map((s) => String(s.run ?? "")).join("\n");
    expect(run).toContain("paths-ignore");
    expect(run).toContain("git rev-list");
  });
});

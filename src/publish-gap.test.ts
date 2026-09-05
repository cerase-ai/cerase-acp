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

  it("the self-heal may dispatch, and dispatches the publish by path", () => {
    expect(selfHeal.permissions?.actions).toBe("write");

    const steps = selfHeal.jobs.heal.steps as Array<Record<string, unknown>>;
    const run = steps.map((s) => String(s.run ?? "")).join("\n");
    // By file path, never by display name: a filter on the name goes blind the
    // day the workflow is renamed, and goes blind silently.
    expect(run).toContain("gh workflow run docker-publish.yml");
  });

  it("it asks the registry, not the run list, because a cancelled publish leaves a run", () => {
    // The most common cause of a commit with no image is a publish superseded
    // by a later push, and a superseded run is never retried. That run EXISTS,
    // so counting runs answers "it ran" for exactly the case this is for. A
    // tag is the fact a deploy can pull; `fleet-red-main.yml` in cerase-core
    // draws the same distinction, in those words.
    const steps = selfHeal.jobs.heal.steps as Array<Record<string, unknown>>;
    const run = steps.map((s) => String(s.run ?? "")).join("\n");
    expect(run).toContain("docker manifest inspect");
    expect(run).not.toContain("/runs?head_sha");
    expect(selfHeal.permissions?.packages).toBe("read");
  });

  it("it tells a registry it could not read apart from an absent image", () => {
    // Two outcomes would dispatch a full image build every morning against a
    // registry that is merely refusing us — and this repository's Actions bill
    // is a standing concern.
    const steps = selfHeal.jobs.heal.steps as Array<Record<string, unknown>>;
    const run = steps.map((s) => String(s.run ?? "")).join("\n");
    expect(run).toContain("unreadable");
    expect(run).toContain("not-expected");
    expect(run).toContain("manifest unknown");
  });

  it("the self-heal honours the publish's own path filter", () => {
    // `docker-publish.yml` ignores the devplan directory, so a planning-only
    // commit correctly produces no image. A self-heal that did not know this
    // would read that as a gap and rebuild every morning after every plan
    // edit — so it walks back to the newest commit an image was expected for,
    // rather than judging the head alone.
    const ignored = publish.on.push["paths-ignore"] as string[];
    expect(ignored).toContain("devplan/**");

    const steps = selfHeal.jobs.heal.steps as Array<Record<string, unknown>>;
    const run = steps.map((s) => String(s.run ?? "")).join("\n");
    expect(run).toContain("devplan/");
    // It walks back to the newest commit an image was expected for, rather than
    // judging the head alone.
    expect(run).toContain("git rev-list");
  });
});

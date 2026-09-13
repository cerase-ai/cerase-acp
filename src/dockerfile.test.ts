import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// dockerfile.test.ts lives at src/dockerfile.test.ts → repo root is one dir up.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
const dockerignore = readFileSync(join(repoRoot, ".dockerignore"), "utf8");

// Lightweight Dockerfile lint — locks in the structural decisions
// without requiring a real `docker build` in the test loop. The real
// build is exercised manually + in the cerase repo's e2e-discord
// tier (B5).

describe("Dockerfile", () => {
  it("uses a multi-stage build (build stage + runtime stage)", () => {
    const fromLines = dockerfile.split("\n").filter((l) => /^FROM\s/i.test(l));
    expect(fromLines.length).toBeGreaterThanOrEqual(2);
  });

  it("runtime stage is node 22 slim (OPT-22 LTS bump)", () => {
    const fromLines = dockerfile.split("\n").filter((l) => /^FROM\s/i.test(l));
    const last = fromLines.at(-1)!;
    expect(last).toMatch(/node:22[.\d]*-slim/);
  });

  // Locks in three findings: an immutable digest pin, npm stripped from the
  // runtime image, and a scan gate that would catch a regression.
  it("pins every base image to an immutable digest", () => {
    // `node:22-slim` is a mutable tag: it can be re-pushed, so the same
    // Dockerfile silently builds a different image tomorrow. cerase-agent
    // pins by digest; this image was left unpinned and nobody noticed,
    // because it has no scan gate either (see below).
    const fromLines = dockerfile.split("\n").filter((l) => /^FROM\s/i.test(l));
    for (const line of fromLines) {
      expect(line, `unpinned base image: ${line.trim()}`).toMatch(/@sha256:[0-9a-f]{64}/);
    }
  });

  it("strips the bundled npm from the RUNTIME stage", () => {
    // The runtime CMD is `node dist/index.js` — npm is used only in the
    // discarded build stage. Left in the runtime layer it is dead weight that
    // carries the whole npm-bundled CVE class (npm 10.9.8 / sigstore 3.1.0 /
    // picomatch), which is exactly what blocked cerase-agent's Trivy gate.
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
    expect(runtime).toMatch(/rm -rf[^\n]*\/usr\/local\/lib\/node_modules\/npm/s);
    expect(runtime).toMatch(/\/usr\/local\/bin\/npx/s);
  });

  it("keeps npm in the BUILD stage, which needs it", () => {
    // The strip must not be so eager it breaks `npm ci` / `npm run build`.
    const build = dockerfile.slice(0, dockerfile.lastIndexOf("\nFROM "));
    expect(build).toMatch(/npm ci/);
    expect(build).not.toMatch(/rm -rf[^\n]*node_modules\/npm/s);
  });
});

describe("the runtime stage and the scan that holds it", () => {
  type Step = { name?: string; uses?: string; with?: Record<string, unknown> };
  const publish = parse(readFileSync(join(repoRoot, ".github/workflows/docker-publish.yml"), "utf8"));
  const ci = parse(readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8"));
  const steps = publish.jobs["build-and-push"].steps as Step[];
  const isBuild = (s: Step) => String(s.uses ?? "").startsWith("docker/build-push-action");
  const scanBuildAt = steps.findIndex((s) => isBuild(s) && s.with?.load === true);
  const trivyAt = steps.findIndex((s) => String(s.uses ?? "").startsWith("aquasecurity/trivy-action"));
  const pushBuildAt = steps.findIndex((s) => isBuild(s) && s.with?.push !== undefined);
  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
  const runtimeAlias = /^\nFROM\s+\S+\s+AS\s+(\S+)/i.exec(runtimeStage)?.[1];

  // The digest pin freezes the base, and debian publishes security fixes
  // against it every week: a pinned image that never upgrades reds the
  // blocking scan on the first advisory with a fix, and stays red until the
  // pin moves.
  it("applies the published debian security upgrades in the runtime stage", () => {
    expect(runtimeStage).toMatch(/apt-get update[\s\S]*?apt-get -y upgrade[\s\S]*?apt-get install/);
  });

  it("scans the image before it is pushed, and blocks on a fixable HIGH or CRITICAL", () => {
    expect(scanBuildAt).toBeGreaterThanOrEqual(0);
    expect(trivyAt).toBeGreaterThan(scanBuildAt);
    expect(pushBuildAt).toBeGreaterThan(trivyAt);
    const trivy = steps[trivyAt]!.with!;
    expect(trivy["image-ref"]).toBe(steps[scanBuildAt]!.with!.tags);
    expect(trivy.severity).toBe("HIGH,CRITICAL");
    expect(trivy["ignore-unfixed"]).toBe(true);
    expect(String(trivy["exit-code"])).toBe("1");
  });

  // A cached apt layer keeps the packages of the day it was first built, so a
  // scan build that reads it can never see a fix debian has published since.
  // The filter names a stage by alias; an alias that no longer exists makes it
  // a no-op that nothing reports.
  it("builds the scanned image without the cached runtime stage", () => {
    expect(runtimeAlias).toBe("runtime");
    expect(steps[scanBuildAt]!.with!["no-cache-filters"]).toBe(runtimeAlias);
    expect(String(steps[scanBuildAt]!.with!["cache-to"])).toMatch(/^type=gha/);
  });

  // The push build must reproduce the image Trivy approved. It does that by
  // reading the cache the scan build has just written; a second apt run could
  // meet a different mirror and push packages nobody scanned.
  it("pushes the image it scanned, from the cache the scan build wrote", () => {
    const push = steps[pushBuildAt]!.with!;
    expect(push["no-cache-filters"]).toBeUndefined();
    expect(push["cache-from"]).toBe(steps[scanBuildAt]!.with!["cache-from"]);
  });

  // The gate is called by the publish, so a scan there on a push is a second
  // build of an image that is not the one pushed, billed on every commit.
  it("leaves the gate's image scan to pull requests, which push nothing", () => {
    const gateScan = Object.values(ci.jobs as Record<string, { steps: Step[]; if?: string }>).find((job) =>
      job.steps.some((s) => String(s.uses ?? "").startsWith("aquasecurity/trivy-action")),
    );
    expect(gateScan?.if).toBe("github.event_name == 'pull_request'");
  });
});

describe("CI", () => {
  it("installs tini and runs it as PID 1", () => {
    expect(dockerfile).toMatch(/apt-get .*install.* tini/s);
    expect(dockerfile).toMatch(/ENTRYPOINT \["\/usr\/bin\/tini",\s*"--"\]/);
  });

  it("installs docker.io for spawning sibling-container opencode acp processes", () => {
    expect(dockerfile).toMatch(/apt-get .*install.* docker\.io/s);
  });

  it("runs the built bundle as the default CMD", () => {
    expect(dockerfile).toMatch(/CMD .*dist\/index\.js/);
  });

  it("does NOT copy node_modules from the host (build stage installs them)", () => {
    // The build stage runs `npm ci`; the runtime stage copies only the
    // dist + the prod node_modules subset from the build stage.
    expect(dockerfile).not.toMatch(/^COPY\s+node_modules/m);
  });

  it("runs `npm ci` in the build stage (not `npm install`)", () => {
    expect(dockerfile).toMatch(/npm ci/);
  });
});

describe(".dockerignore", () => {
  it("excludes node_modules, dist, .git, agents.yaml", () => {
    expect(dockerignore).toMatch(/^node_modules$/m);
    expect(dockerignore).toMatch(/^dist$/m);
    expect(dockerignore).toMatch(/^\.git$/m);
    expect(dockerignore).toMatch(/^agents\.yaml$/m);
  });

  // `.claude/worktrees/` holds a full checkout per background agent. It was
  // half a gigabyte in this repository, untracked, unignored, and therefore
  // inside the build context of every local `cli.sh build` — a checkout of a
  // DIFFERENT branch shipped to the docker daemon on every one of them.
  // It is in `.gitignore` too; this asserts the half that `git status` cannot
  // show, because a directory can be ignored by git and still be sent to
  // docker.
  it("excludes agent worktrees, which are a checkout inside the checkout", () => {
    expect(dockerignore).toMatch(/^\.claude$/m);
  });
});

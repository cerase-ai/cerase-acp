import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

  it("runtime stage is node:22-slim (OPT-22 LTS bump)", () => {
    const fromLines = dockerfile.split("\n").filter((l) => /^FROM\s/i.test(l));
    const last = fromLines.at(-1)!;
    expect(last).toMatch(/node:22-slim/);
  });

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
});

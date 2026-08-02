import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

  // M-ACP-NPM-STRIP-1 — the three findings that milestone opened, locked here.
  it("pins every base image to an immutable digest", () => {
    // `node:22-slim` is a MUTABLE tag: it can be re-pushed, so the same
    // Dockerfile silently builds a different image tomorrow. cerase-agent
    // pinned by digest under M-SUPPLY-PIN-1; this image was left unpinned and
    // nobody noticed, because it has no scan gate either (see below).
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

describe("CI", () => {
  const ci = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");

  it("scans the built image with Trivy and blocks on HIGH/CRITICAL", () => {
    // M-ACP-NPM-STRIP-1: the npm exposure was invisible here not because it was
    // absent but because the ALARM was — two node images in the fleet, one
    // gated by Trivy and one not. A vulnerability nobody scans for is not a
    // vulnerability anyone finds.
    expect(ci).toMatch(/trivy-action/);
    expect(ci).toMatch(/severity:\s*HIGH,CRITICAL/);
    expect(ci).toMatch(/exit-code:\s*['"]1['"]/);
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

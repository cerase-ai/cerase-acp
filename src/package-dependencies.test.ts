import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};
const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8")) as {
  packages: Record<string, { dependencies?: Record<string, string> }>;
};

/** Every source file that ships in the image: src without its tests and test helpers. */
function shippedSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : shippedSources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

function importedPackages(): string[] {
  const names = new Set<string>();
  for (const file of shippedSources(here)) {
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/(?:from|import\()\s*"([^".][^"]*)"/g)) {
      const specifier = m[1]!;
      if (specifier.startsWith("node:")) continue;
      const parts = specifier.split("/");
      names.add(specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!);
    }
  }
  return [...names].sort();
}

// `npm prune --omit=dev` in the image keeps what package.json declares and
// whatever those packages pull in. A package the code imports but only reaches
// as somebody else's dependency is installed by accident, and goes the day
// that somebody drops it or moves to a major that no longer carries it.
describe("runtime dependencies", () => {
  it("every package the shipped code imports is declared as a direct dependency", () => {
    const declared = Object.keys(pkg.dependencies);
    expect(importedPackages().filter((name) => !declared.includes(name))).toEqual([]);
  });

  // A declared dependency nothing imports is installed into every image, and
  // its whole tree is scanned and patched for nothing.
  it("every declared runtime dependency is imported by the shipped code", () => {
    const imported = importedPackages();
    expect(Object.keys(pkg.dependencies).filter((name) => !imported.includes(name))).toEqual([]);
  });

  it("the lockfile's root entry declares the same dependencies, so npm ci accepts it", () => {
    expect(lock.packages[""]?.dependencies).toEqual(pkg.dependencies);
  });
});

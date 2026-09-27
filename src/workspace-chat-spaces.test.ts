import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceChatSpaces } from "./workspace-chat-spaces.js";

// A message nobody's event opened (a scheduled one, a notice, a reply after the
// bridge restarted) had no space and asked Google for the direct-message space
// by email, which a service account may not do: HTTP 403, delivered nowhere.
describe("the direct-message space a person last wrote from", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("is remembered across a restart of the bridge", () => {
    dir = mkdtempSync(join(tmpdir(), "wc-spaces-"));
    new WorkspaceChatSpaces(dir).remember("mario.rossi@example.com", "spaces/AAA");
    expect(new WorkspaceChatSpaces(dir).known("mario.rossi@example.com")).toBe("spaces/AAA");
  });

  it("is kept in memory when there is nowhere to write it", () => {
    const spaces = new WorkspaceChatSpaces(undefined);
    spaces.remember("mario.rossi@example.com", "spaces/AAA");
    expect(spaces.known("mario.rossi@example.com")).toBe("spaces/AAA");
    expect(new WorkspaceChatSpaces(undefined).known("mario.rossi@example.com")).toBeUndefined();
  });

  it("survives a file that cannot be read", () => {
    dir = mkdtempSync(join(tmpdir(), "wc-spaces-"));
    writeFileSync(join(dir, "workspace-chat-spaces.json"), "{not json");
    expect(new WorkspaceChatSpaces(dir).known("x@example.com")).toBeUndefined();
  });
});

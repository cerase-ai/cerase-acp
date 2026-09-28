import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceChatSpaces } from "./workspace-chat-spaces.js";

const APP = "111111111111";
const APP_2 = "222222222222";
const FILE = "workspace-chat-spaces.json";

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
    new WorkspaceChatSpaces(dir, APP).remember("mario.rossi@example.com", "spaces/AAA");
    expect(new WorkspaceChatSpaces(dir, APP).known("mario.rossi@example.com")).toBe("spaces/AAA");
  });

  it("is kept in memory when there is nowhere to write it", () => {
    const spaces = new WorkspaceChatSpaces(undefined, APP);
    spaces.remember("mario.rossi@example.com", "spaces/AAA");
    expect(spaces.known("mario.rossi@example.com")).toBe("spaces/AAA");
    expect(new WorkspaceChatSpaces(undefined, APP).known("mario.rossi@example.com")).toBeUndefined();
  });

  it("survives a file that cannot be read", () => {
    dir = mkdtempSync(join(tmpdir(), "wc-spaces-"));
    writeFileSync(join(dir, FILE), "{not json");
    expect(new WorkspaceChatSpaces(dir, APP).known("x@example.com")).toBeUndefined();
  });

  // One person with two assistants has two direct-message spaces, one per Chat
  // app. Keyed by the person alone, the file held whichever app wrote last, and
  // after a restart the other app posted into a space it is not a member of.
  it("is kept per Chat app, so one person's two assistants keep two spaces", () => {
    dir = mkdtempSync(join(tmpdir(), "wc-spaces-"));
    const one = new WorkspaceChatSpaces(dir, APP);
    const two = new WorkspaceChatSpaces(dir, APP_2);
    one.remember("mario.rossi@example.com", "spaces/ONE");
    two.remember("mario.rossi@example.com", "spaces/TWO");
    expect(new WorkspaceChatSpaces(dir, APP).known("mario.rossi@example.com")).toBe("spaces/ONE");
    expect(new WorkspaceChatSpaces(dir, APP_2).known("mario.rossi@example.com")).toBe("spaces/TWO");
  });

  // Every adapter holds its own instance over the one file. A write that put
  // out only what its own instance held would drop what another wrote since.
  it("keeps what another instance wrote to the same file", () => {
    dir = mkdtempSync(join(tmpdir(), "wc-spaces-"));
    const first = new WorkspaceChatSpaces(dir, APP);
    const second = new WorkspaceChatSpaces(dir, APP);
    first.remember("mario.rossi@example.com", "spaces/MARIO");
    second.remember("anna.bianchi@example.com", "spaces/ANNA");
    const after = new WorkspaceChatSpaces(dir, APP);
    expect(after.known("mario.rossi@example.com")).toBe("spaces/MARIO");
    expect(after.known("anna.bianchi@example.com")).toBe("spaces/ANNA");
  });

  // The earlier file named a space per person and no app. It cannot say whose
  // space it is, so it is not used; the next write replaces it.
  it("ignores a file in the earlier per-person shape and replaces it on the next write", () => {
    dir = mkdtempSync(join(tmpdir(), "wc-spaces-"));
    writeFileSync(join(dir, FILE), JSON.stringify({ "mario.rossi@example.com": "spaces/OTHER-APP" }));
    const spaces = new WorkspaceChatSpaces(dir, APP);
    expect(spaces.known("mario.rossi@example.com")).toBeUndefined();
    spaces.remember("mario.rossi@example.com", "spaces/MINE");
    expect(JSON.parse(readFileSync(join(dir, FILE), "utf8"))).toEqual({
      by_app: { [APP]: { "mario.rossi@example.com": "spaces/MINE" } },
    });
  });

  it("forgets an entry, and only while it still names the space that was refused", () => {
    dir = mkdtempSync(join(tmpdir(), "wc-spaces-"));
    const spaces = new WorkspaceChatSpaces(dir, APP);
    spaces.remember("mario.rossi@example.com", "spaces/NEW");
    spaces.forget("mario.rossi@example.com", "spaces/OLD");
    expect(new WorkspaceChatSpaces(dir, APP).known("mario.rossi@example.com")).toBe("spaces/NEW");
    spaces.forget("mario.rossi@example.com", "spaces/NEW");
    expect(spaces.known("mario.rossi@example.com")).toBeUndefined();
    expect(new WorkspaceChatSpaces(dir, APP).known("mario.rossi@example.com")).toBeUndefined();
  });
});

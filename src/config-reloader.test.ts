import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigReloader } from "./config-reloader.js";
import type { BridgeConfig } from "./config.js";

const VALID_YAML_A = `
agents:
  - id: alpha
    bot_token: tok-a
    allowed_users:
      - u-1
    spawn:
      command: docker
      args: [exec, -i, cerase-agent-1, opencode, acp]
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`;

const VALID_YAML_B = `
agents:
  - id: alpha
    bot_token: tok-a
    allowed_users:
      - u-1
      - u-2
    spawn:
      command: docker
      args: [exec, -i, cerase-agent-1, opencode, acp]
session:
  idle_timeout_minutes: 60
  max_concurrent: 16
`;

const MALFORMED_YAML = "agents: [\n  - id: broken";

describe("ConfigReloader", () => {
  let dir: string;
  let cfgPath: string;
  let reloader: ConfigReloader | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "config-reloader-"));
    cfgPath = join(dir, "agents.yaml");
    reloader = undefined;
  });

  afterEach(() => {
    reloader?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("fires onChange with the parsed config when the file is written", async () => {
    writeFileSync(cfgPath, VALID_YAML_A);
    const events: BridgeConfig[] = [];
    reloader = new ConfigReloader(cfgPath, (cfg) => events.push(cfg), { debounceMs: 20 });
    reloader.start();

    // Trigger a change after start
    writeFileSync(cfgPath, VALID_YAML_B);
    await wait(120);

    expect(events.length).toBeGreaterThanOrEqual(1);
    const latest = events[events.length - 1]!;
    expect(latest.agents[0]!.allowed_users).toEqual(["u-1", "u-2"]);
  });

  it("debounces rapid successive writes into a single onChange call", async () => {
    writeFileSync(cfgPath, VALID_YAML_A);
    const events: BridgeConfig[] = [];
    reloader = new ConfigReloader(cfgPath, (cfg) => events.push(cfg), { debounceMs: 60 });
    reloader.start();

    // Three writes within the debounce window
    writeFileSync(cfgPath, VALID_YAML_B);
    await wait(10);
    writeFileSync(cfgPath, VALID_YAML_A);
    await wait(10);
    writeFileSync(cfgPath, VALID_YAML_B);

    await wait(150);
    expect(events.length).toBe(1);
    expect(events[0]!.agents[0]!.allowed_users).toEqual(["u-1", "u-2"]);
  });

  it("does NOT call onChange when the new YAML is malformed (logs + skips)", async () => {
    writeFileSync(cfgPath, VALID_YAML_A);
    const events: BridgeConfig[] = [];
    reloader = new ConfigReloader(cfgPath, (cfg) => events.push(cfg), { debounceMs: 20 });
    reloader.start();

    writeFileSync(cfgPath, MALFORMED_YAML);
    await wait(120);

    expect(events.length).toBe(0);
  });

  it("recovers after a malformed write — next valid write fires onChange", async () => {
    writeFileSync(cfgPath, VALID_YAML_A);
    const events: BridgeConfig[] = [];
    reloader = new ConfigReloader(cfgPath, (cfg) => events.push(cfg), { debounceMs: 20 });
    reloader.start();

    writeFileSync(cfgPath, MALFORMED_YAML);
    await wait(80);
    writeFileSync(cfgPath, VALID_YAML_B);
    await wait(120);

    expect(events.length).toBe(1);
    expect(events[0]!.agents[0]!.allowed_users).toEqual(["u-1", "u-2"]);
  });

  it("stop() detaches the watcher and prevents further onChange calls", async () => {
    writeFileSync(cfgPath, VALID_YAML_A);
    const events: BridgeConfig[] = [];
    reloader = new ConfigReloader(cfgPath, (cfg) => events.push(cfg), { debounceMs: 20 });
    reloader.start();
    reloader.stop();

    writeFileSync(cfgPath, VALID_YAML_B);
    await wait(120);

    expect(events.length).toBe(0);
  });
});

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

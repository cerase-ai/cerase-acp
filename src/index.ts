// cerase-acp entry point. All wiring lives in src/bridge.ts so it can
// be unit-tested with injected adapter factories. This file just reads
// env, calls runBridge, and wires signals to the shutdown handle.

import { makeLogger } from "./logger.js";
import { loadConfig } from "./config.js";
import { runBridge } from "./bridge.js";

const logger = makeLogger("cerase-acp");

// M-ACP-CRASH-1: defense-in-depth. A stray unhandled rejection (a discarded
// promise chain in this code or a dependency) must NOT take the whole
// multi-tenant bridge down — one user's recoverable failure should never
// disconnect every other user. Log loudly and keep serving; the in-band
// error handling (dispatcher turn-error copy, per-spawn catch) already
// surfaces real failures to the affected user.
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "unhandledRejection — logged, bridge kept alive");
});

async function main(): Promise<void> {
  const cfgPath = process.env.CERASE_ACP_CONFIG ?? "/etc/cerase-acp/agents.yaml";
  const cfg = loadConfig(cfgPath);
  logger.info({ configPath: cfgPath, agentCount: cfg.agents.length }, "cerase-acp starting");

  const handle = await runBridge({
    config: cfg,
    bridgeE2eTest: process.env.BRIDGE_E2E_TEST === "1",
    // v0.2: pass the config path so runBridge instantiates a
    // ConfigReloader that watches agents.yaml for live updates.
    // The bridge auto-reloads in place — no more docker restart.
    configPath: cfgPath,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    try {
      await handle.shutdown();
    } catch (err) {
      logger.error({ err }, "error during shutdown");
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err }, "cerase-acp failed to start");
  process.exit(1);
});

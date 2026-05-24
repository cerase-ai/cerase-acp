// cerase-acp entry point. All wiring lives in src/bridge.ts so it can
// be unit-tested with injected adapter factories. This file just reads
// env, calls runBridge, and wires signals to the shutdown handle.

import pino from "pino";
import { loadConfig } from "./config.js";
import { runBridge } from "./bridge.js";

const logger = pino({
  name: "cerase-acp",
  level: process.env.CERASE_ACP_LOG_LEVEL ?? "info",
});

async function main(): Promise<void> {
  const cfgPath = process.env.CERASE_ACP_CONFIG ?? "/etc/cerase-acp/agents.yaml";
  const cfg = loadConfig(cfgPath);
  logger.info({ configPath: cfgPath, agentCount: cfg.agents.length }, "cerase-acp starting");

  const handle = await runBridge({
    config: cfg,
    bridgeE2eTest: process.env.BRIDGE_E2E_TEST === "1",
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

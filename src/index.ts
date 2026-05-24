// cerase-acp entry point. Wires:
//   config.yaml → SessionManager + TurnMetaTracker + Dispatcher
//   per-agent discord.js clients (DiscordAdapter)
//   optional BRIDGE_E2E_TEST HTTP server on :7474
//
// SIGINT/SIGTERM trigger a graceful shutdown: stop accepting new DMs,
// kill all ACP children, close the test server if open.

import pino from "pino";
import { loadConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { TurnMetaTracker } from "./turn-meta.js";
import { Dispatcher } from "./dispatcher.js";
import { createDiscordAdapter, type DiscordAdapter } from "./discord-adapter.js";
import { startTestInjectionServer, type TestInjectionServer } from "./test-injection.js";

const logger = pino({
  name: "cerase-acp",
  level: process.env.CERASE_ACP_LOG_LEVEL ?? "info",
});

async function main(): Promise<void> {
  const cfgPath = process.env.CERASE_ACP_CONFIG ?? "/etc/cerase-acp/agents.yaml";
  const cfg = loadConfig(cfgPath);
  logger.info(
    { configPath: cfgPath, agentCount: cfg.agents.length },
    "cerase-acp starting",
  );

  const sessionManager = new SessionManager(cfg);
  const turnMeta = new TurnMetaTracker();

  // Per-agent adapter table. Built before the dispatcher so
  // resolveSendTarget can look up the right adapter's send fn.
  const adapters = new Map<string, DiscordAdapter>();
  for (const agent of cfg.agents) {
    // We need a dispatcher reference inside createDiscordAdapter, but
    // dispatcher depends on adapters too. Resolve via a forward ref
    // pattern below.
    adapters.set(agent.id, null as unknown as DiscordAdapter);
  }

  const dispatcher = new Dispatcher({
    config: cfg,
    sessionManager,
    turnMeta,
    resolveSendTarget: (agentId, userId) => {
      const adapter = adapters.get(agentId);
      if (!adapter) {
        throw new Error(`no Discord adapter registered for agent "${agentId}"`);
      }
      return adapter.makeSendTarget(userId);
    },
  });

  // Now create the real adapters (they capture `dispatcher` by closure)
  // and replace the placeholders.
  for (const agent of cfg.agents) {
    adapters.set(agent.id, createDiscordAdapter(agent, dispatcher));
  }

  // Start all clients in parallel.
  await Promise.all(Array.from(adapters.values()).map((a) => a.start()));
  logger.info({ agentCount: adapters.size }, "all discord clients ready");

  // Optional test-injection HTTP server.
  let testServer: TestInjectionServer | undefined;
  if (process.env.BRIDGE_E2E_TEST === "1") {
    testServer = await startTestInjectionServer({ dispatcher, port: 7474 });
    logger.warn({ url: testServer.url() }, "BRIDGE_E2E_TEST=1 — test-injection endpoint ENABLED");
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    try {
      if (testServer) await testServer.close();
      await Promise.all(Array.from(adapters.values()).map((a) => a.stop()));
      await sessionManager.shutdown();
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

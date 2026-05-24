// runBridge — wires config → session-manager + turn-meta + per-agent
// adapter table + dispatcher, and (optionally) the BRIDGE_E2E_TEST
// HTTP server. Extracted from index.ts so tests can drive it with a
// fake adapter factory (no real discord.js logins).
//
// Test-mode resilience contract:
//   - `bridgeE2eTest: true` → start the test-injection server FIRST,
//     then run each adapter.start() inside its own try/catch. A
//     failed login (e.g. fake bot token in dev) is logged but does NOT
//     reject runBridge: the test server stays up so the developer can
//     still talk to the bridge via /_test/inject.
//   - `bridgeE2eTest: false` (production) → no test server; adapter
//     starts run in Promise.all; any rejection bubbles up as fail-fast.

import pino from "pino";
import type { AgentConfig, BridgeConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { TurnMetaTracker } from "./turn-meta.js";
import { Dispatcher } from "./dispatcher.js";
import { createDiscordAdapter, type DiscordAdapter } from "./discord-adapter.js";
import { startTestInjectionServer, type TestInjectionServer } from "./test-injection.js";

const logger = pino({
  name: "cerase-acp.bridge",
  level: process.env.CERASE_ACP_LOG_LEVEL ?? "info",
});

export interface RunBridgeOptions {
  config: BridgeConfig;
  bridgeE2eTest: boolean;
  /** Port for the test-injection server (only when bridgeE2eTest=true). 7474 in prod, 0 in tests. */
  testInjectionPort?: number;
  /** Adapter factory for dependency injection in tests. Defaults to the real discord.js wiring. */
  createAdapter?: (agent: AgentConfig, dispatcher: Dispatcher) => DiscordAdapter;
}

export interface RunBridgeHandle {
  /** Set only when bridgeE2eTest=true. */
  testInjectionUrl?: string;
  shutdown(): Promise<void>;
}

export async function runBridge(opts: RunBridgeOptions): Promise<RunBridgeHandle> {
  const { config, bridgeE2eTest } = opts;
  const createAdapter = opts.createAdapter ?? createDiscordAdapter;

  const sessionManager = new SessionManager(config);
  const turnMeta = new TurnMetaTracker();

  // Two dispatchers share SessionManager + TurnMetaTracker but differ
  // in send-target: the discord one routes replies back to a DM
  // channel; the test-injection one routes replies to the test
  // server's recordReply table. Without this split, /_test/inject
  // requests would try to deliver replies through a Discord client
  // that's not logged in (intentionally, in test mode) — failures get
  // swallowed by the send-queue's error handler and the test sees
  // 404 on /_test/last-reply.

  // Build the adapter table BEFORE the discord dispatcher so
  // resolveSendTarget can look up the right adapter.
  const adapters = new Map<string, DiscordAdapter>();

  const discordDispatcher = new Dispatcher({
    config,
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

  for (const agent of config.agents) {
    adapters.set(agent.id, createAdapter(agent, discordDispatcher));
  }

  // Test-mode: start the test server BEFORE the adapters so it's
  // reachable even if every login fails. The test-injection dispatcher
  // uses a forward-reference to the server's recordReply.
  let testServer: TestInjectionServer | undefined;
  if (bridgeE2eTest) {
    let serverRef: TestInjectionServer | undefined;
    const testDispatcher = new Dispatcher({
      config,
      sessionManager,
      turnMeta,
      resolveSendTarget: (agentId, userId) => async (chunk) => {
        serverRef?.recordReply(agentId, userId, chunk);
      },
    });
    testServer = await startTestInjectionServer({
      dispatcher: testDispatcher,
      port: opts.testInjectionPort ?? 7474,
    });
    serverRef = testServer;
    logger.warn(
      { url: testServer.url() },
      "BRIDGE_E2E_TEST=1 — test-injection endpoint ENABLED (never enable in production)",
    );
  }

  // Start adapters. In test-mode, swallow failures (log each one) so
  // the bridge stays up. In production, fan out via Promise.all and
  // let rejections bubble — a token error is a real config bug.
  if (bridgeE2eTest) {
    for (const adapter of adapters.values()) {
      try {
        await adapter.start();
      } catch (err) {
        logger.error(
          { err, agentId: adapter.agentId },
          "adapter.start() failed in BRIDGE_E2E_TEST mode — continuing with test server reachable",
        );
      }
    }
  } else {
    try {
      await Promise.all(Array.from(adapters.values()).map((a) => a.start()));
    } catch (err) {
      // Best-effort teardown so we don't leak resources on the way out.
      logger.error({ err }, "adapter start failed in production mode — tearing down");
      await Promise.allSettled([
        ...Array.from(adapters.values()).map((a) => a.stop()),
        sessionManager.shutdown(),
      ]);
      throw err;
    }
  }

  logger.info(
    { agentCount: adapters.size, bridgeE2eTest },
    "cerase-acp bridge ready",
  );

  return {
    testInjectionUrl: testServer?.url(),
    async shutdown() {
      // Order: stop discord clients → close test server → kill ACP children.
      // Reverse of startup so dependents go first.
      await Promise.allSettled(Array.from(adapters.values()).map((a) => a.stop()));
      if (testServer) await testServer.close();
      await sessionManager.shutdown();
    },
  };
}

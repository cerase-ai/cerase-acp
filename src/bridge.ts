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

import { makeLogger } from "./logger.js";
import type { AgentConfig, BridgeConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { TurnMetaTracker } from "./turn-meta.js";
import { Dispatcher } from "./dispatcher.js";
import { createChatAdapter, type ChatAdapter } from "./chat-adapter.js";
import { startTestInjectionServer, type TestInjectionServer } from "./test-injection.js";
import { startInternalServer, type InternalServer } from "./internal-server.js";
import { needsApprovalLink, applyApprovalLink, applyApprovalLinkFallback, fetchPendingApprovalLink } from "./approval-link.js";
import { parseAttachments, hasAttachments } from "./attachment.js";
import { redactEngineIdentifiers } from "./egress-redaction.js";
import { readAgentWorkspaceFile } from "./workspace-files.js";
import { ConfigReloader } from "./config-reloader.js";
import { diffConfigs, type ConfigDiff } from "./config-diff.js";

const logger = makeLogger("cerase-acp.bridge");

export interface RunBridgeOptions {
  config: BridgeConfig;
  bridgeE2eTest: boolean;
  /** Port for the test-injection server (only when bridgeE2eTest=true). 7474 in prod, 0 in tests. */
  testInjectionPort?: number;
  /**
   * Adapter factory for dependency injection in tests. Defaults to the
   * real cross-channel factory (`createChatAdapter`), which dispatches
   * on `agent.channel`. Returns a Promise to support lazy-loading of
   * the per-channel transport library (discord.js / telegraf / @slack/bolt
   * / @google-apis/chat). Tests typically supply a synchronous fake and
   * wrap it in Promise.resolve.
   */
  createAdapter?: (agent: AgentConfig, dispatcher: Dispatcher) => Promise<ChatAdapter>;
  /**
   * Path of the agents.yaml the bridge should watch for live updates
   * (M-auto-reload v0.2). When set, runBridge instantiates a
   * ConfigReloader; on each successful reload the diff is applied to
   * the live adapters table + SessionManager. Unset → no watcher
   * (legacy behaviour, used by the test suite and the CLI prompt mode).
   */
  configPath?: string;
}

/**
 * Hot-ops surface that SessionManager exposes to the auto-reload
 * handler. Declared as an interface (rather than imported directly
 * from session-manager.ts) so tests can substitute a fake without
 * dragging the full SessionManager in.
 */
export interface SessionManagerHotOps {
  addAgent(agent: AgentConfig): void;
  removeAgent(agentId: string): void;
  killAgentSessions(agentId: string): void;
  updateAllowlist(agentId: string, allowed_users: string[]): void;
}

export interface ApplyConfigDiffDeps {
  /** The NEW bridge config (post-reload). Diff-handler needs it to
   * resolve the AgentConfig for `bot_token_or_spawn` respawns. */
  next: BridgeConfig;
  sessionManager: SessionManagerHotOps;
  adapters: Map<string, ChatAdapter>;
  createAdapter: (agent: AgentConfig, dispatcher: Dispatcher) => Promise<ChatAdapter>;
  dispatcher: Dispatcher;
}

/**
 * M-ACP-2 — bounded-retry adapter creation: one agent's bad token /
 * transient platform error must not abort the whole reload (the
 * remaining agents were never processed). One retry, then give up on
 * THAT agent and continue; the failure is logged loudly (a missing
 * adapter surfaces via the reload-status path).
 */
async function createAdapterWithRetry(
  deps: ApplyConfigDiffDeps,
  agent: AgentConfig,
): Promise<ChatAdapter | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await deps.createAdapter(agent, deps.dispatcher);
    } catch (err) {
      logger.error(
        { err, agentId: agent.id, attempt },
        attempt === 1
          ? "auto-reload: createAdapter failed — retrying once"
          : "auto-reload: createAdapter failed twice — SKIPPING this agent (it will not receive DMs until the next reload)",
      );
    }
  }
  return null;
}

/**
 * Applies a ConfigDiff to the live bridge state. Pure side-effects on
 * SessionManager + the adapters Map; no IO besides what those callees
 * perform. Exported for unit testing — runBridge wires it as the
 * onChange handler of ConfigReloader.
 */
export async function applyConfigDiff(
  diff: ConfigDiff,
  deps: ApplyConfigDiffDeps,
): Promise<void> {
  // 1. Remove old agents first (frees adapter resources before any
  //    same-id add would collide). Stops the adapter, then asks the
  //    SessionManager to terminate ACP children and drop the agent
  //    from its agentsById map.
  for (const id of diff.removed) {
    const adapter = deps.adapters.get(id);
    if (adapter) {
      try {
        await adapter.stop();
      } catch (err) {
        logger.error({ err, agentId: id }, "auto-reload: adapter.stop() failed during remove");
      }
      deps.adapters.delete(id);
    }
    deps.sessionManager.removeAgent(id);
  }

  // 2. Apply per-agent mutations.
  for (const mod of diff.modified) {
    if (mod.classification === "allowed_users_only") {
      const next = deps.next.agents.find((a) => a.id === mod.agentId);
      if (next) {
        deps.sessionManager.updateAllowlist(mod.agentId, next.allowed_users);
        logger.info(
          { agentId: mod.agentId, allowed_users: next.allowed_users },
          "auto-reload: allowed_users updated in place",
        );
      }
    } else {
      // bot_token_or_spawn OR mixed → respawn this agent's adapter.
      const oldAdapter = deps.adapters.get(mod.agentId);
      if (oldAdapter) {
        try {
          await oldAdapter.stop();
        } catch (err) {
          logger.error(
            { err, agentId: mod.agentId },
            "auto-reload: adapter.stop() failed during respawn",
          );
        }
        deps.adapters.delete(mod.agentId);
      }
      deps.sessionManager.killAgentSessions(mod.agentId);

      const fresh = deps.next.agents.find((a) => a.id === mod.agentId);
      if (fresh) {
        // OPT-35 fix: the SessionManager keeps an internal AgentConfig
        // reference per agentId; for `mixed` (token + allowed_users
        // both changed) and `bot_token_or_spawn`, we previously only
        // respawned the adapter and left the allowlist stale, so the
        // dispatcher kept rejecting DMs from users that the new
        // agents.yaml WAS authorising. Sync the allowlist here too so
        // every classification path lands at a coherent state.
        deps.sessionManager.updateAllowlist(mod.agentId, fresh.allowed_users);

        const adapter = await createAdapterWithRetry(deps, fresh);
        if (!adapter) continue; // M-ACP-2: skip this agent, keep reloading the rest
        deps.adapters.set(mod.agentId, adapter);
        try {
          await adapter.start();
          logger.info(
            { agentId: mod.agentId, classification: mod.classification },
            "auto-reload: agent respawned",
          );
        } catch (err) {
          logger.error(
            { err, agentId: mod.agentId },
            "auto-reload: respawned adapter.start() failed — agent will not receive DMs",
          );
        }
      }
    }
  }

  // 3. Add new agents. Done last so any same-id removal above is
  //    already settled.
  for (const agent of diff.added) {
    deps.sessionManager.addAgent(agent);
    const adapter = await createAdapterWithRetry(deps, agent);
    if (!adapter) continue; // M-ACP-2: skip this agent, keep reloading the rest
    deps.adapters.set(agent.id, adapter);
    try {
      await adapter.start();
      logger.info({ agentId: agent.id }, "auto-reload: new agent attached");
    } catch (err) {
      logger.error(
        { err, agentId: agent.id },
        "auto-reload: new adapter.start() failed — agent will not receive DMs",
      );
    }
  }
}

export interface RunBridgeHandle {
  /** Set only when bridgeE2eTest=true. */
  testInjectionUrl?: string;
  shutdown(): Promise<void>;
}

export async function runBridge(opts: RunBridgeOptions): Promise<RunBridgeHandle> {
  const { config, bridgeE2eTest } = opts;
  const createAdapter = opts.createAdapter ?? createChatAdapter;

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

  // Build the adapter table BEFORE the production dispatcher so
  // resolveSendTarget can look up the right adapter. Map is shared by
  // both dispatchers (production + test-mode) below.
  const adapters = new Map<string, ChatAdapter>();

  // HITL-3/4 — control-plane internal channel for fetching the
  // server-minted approval link to inject via {{APPROVAL_LINK}}.
  const controlPlaneUrl = process.env.CERASE_CONTROL_PLANE_URL ?? "http://cerase-control-plane:8000";
  // Two distinct secrets:
  //  - controlPlaneSecret: the CONTROL-PLANE internal bearer (same the
  //    gateway uses) — to CALL control-plane internal endpoints.
  //  - acpInjectSecret: guards acp's OWN /internal/inject endpoint;
  //    must match the control-plane's cerase.acp.internal_secret.
  const controlPlaneSecret = process.env.CERASE_INTERNAL_SECRET ?? "";
  const acpInjectSecret = process.env.CERASE_ACP_INTERNAL_SECRET ?? "";

  const productionDispatcher = new Dispatcher({
    config,
    sessionManager,
    turnMeta,
    resolveSendTarget: (agentId, userId) => {
      const adapter = adapters.get(agentId);
      if (!adapter) {
        throw new Error(`no chat adapter registered for agent "${agentId}"`);
      }
      const inner = adapter.makeSendTarget(userId);
      // HITL-3: substitute {{APPROVAL_LINK}} in outgoing chunks with the
      // signed link (fetched over the internal channel — never given to
      // the agent). Only acts on chunks carrying the placeholder, so the
      // common path pays no extra HTTP.
      return async (chunk: string) => {
        let text = chunk;
        // HITL-3: approval link substitution (unchanged).
        if (controlPlaneSecret && needsApprovalLink(text)) {
          try {
            const link = await fetchPendingApprovalLink(agentId, {
              controlPlaneUrl,
              internalSecret: controlPlaneSecret,
            });
            text = applyApprovalLink(text, link);
          } catch (err) {
            // M-ACP-2: fetch failed (≠ no pending approval) — explain
            // instead of silently stripping the placeholder.
            logger.warn({ err, agentId }, "approval-link fetch failed — substituting fallback note");
            text = applyApprovalLinkFallback(text);
          }
        }
        // ATTACH-1: upload workspace files referenced by [[attach: <path>]].
        // The agent emits the marker; we read the file from its slot
        // container's workspace and send it as a channel attachment, never
        // showing the raw marker. Container name follows the cerase-<id>
        // convention (agents.yaml id `agent-1` → container `cerase-agent-1`).
        if (hasAttachments(text)) {
          const parsed = parseAttachments(text);
          const containerName = `cerase-${agentId}`;
          for (const relPath of parsed.attachments) {
            try {
              const file = await readAgentWorkspaceFile(containerName, relPath);
              if (adapter.sendFile) {
                await adapter.sendFile(userId, { name: file.name, bytes: file.bytes });
              } else {
                await inner(`📎 (allegati non supportati su questo canale: ${file.name})`);
              }
            } catch (err) {
              logger.warn({ err, agentId, relPath }, "attach: failed to read/send workspace file");
              await inner(`⚠️ Non sono riuscito ad allegare \`${relPath}\`.`);
            }
          }
          text = parsed.text;
          // If the reply was only the marker, don't send an empty message.
          if (!text) return;
        }
        // M-AGENT-VOICE-1 (A): deterministic engine-identity redaction, the
        // last step before the reply leaves for any channel — never reveal we
        // run on OpenCode, even if the model ignored the prompt-level rule.
        text = redactEngineIdentifiers(text);
        return inner(text);
      };
    },
  });

  for (const agent of config.agents) {
    adapters.set(agent.id, await createAdapter(agent, productionDispatcher));
  }

  // SCHED-2 — productionised injection endpoint the control-plane
  // scheduled-message dispatcher POSTs to (shared-secret). Started when
  // the internal secret is configured.
  let internalServer: InternalServer | undefined;
  if (acpInjectSecret) {
    internalServer = await startInternalServer({
      dispatcher: productionDispatcher,
      internalSecret: acpInjectSecret,
      port: Number(process.env.CERASE_ACP_INTERNAL_PORT ?? "7476"),
    });
    logger.info({ port: internalServer.port() }, "internal injection endpoint started (/internal/inject)");
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

  // M-auto-reload v0.2: watch agents.yaml for live updates.
  // Snapshot the current config so the next reload can compute a diff
  // against a stable reference (the sessionManager mutates the shared
  // `config` object in place once we apply each diff).
  let currentSnapshot: BridgeConfig = cloneConfig(config);
  let reloader: ConfigReloader | undefined;
  if (opts.configPath) {
    reloader = new ConfigReloader(opts.configPath, (nextConfig) => {
      const diff = diffConfigs(currentSnapshot, nextConfig);
      if (
        diff.added.length === 0 &&
        diff.removed.length === 0 &&
        diff.modified.length === 0
      ) {
        return;
      }
      logger.info(
        {
          added: diff.added.map((a) => a.id),
          removed: diff.removed,
          modified: diff.modified,
        },
        "auto-reload: applying config diff",
      );
      // Best-effort: the handler swallows individual adapter errors so
      // a flaky start doesn't crash the bridge. Anything escaping
      // applyConfigDiff itself indicates a bug.
      applyConfigDiff(diff, {
        next: nextConfig,
        sessionManager,
        adapters,
        createAdapter,
        dispatcher: productionDispatcher,
      })
        .then(() => {
          currentSnapshot = cloneConfig(nextConfig);
        })
        .catch((err) => {
          logger.error({ err }, "auto-reload: applyConfigDiff threw — snapshot NOT advanced");
        });
    });
    reloader.start();
    logger.info({ configPath: opts.configPath }, "auto-reload: ConfigReloader started");
  }

  return {
    testInjectionUrl: testServer?.url(),
    async shutdown() {
      // Order: stop reloader → stop discord clients → close test server → kill ACP children.
      // Reverse of startup so dependents go first.
      if (reloader) reloader.stop();
      await Promise.allSettled(Array.from(adapters.values()).map((a) => a.stop()));
      if (testServer) await testServer.close();
      if (internalServer) await internalServer.close();
      await sessionManager.shutdown();
    },
  };
}

/**
 * Deep clone of BridgeConfig so the auto-reload's "previous snapshot"
 * doesn't share array references with the shared config (which
 * SessionManager mutates in place via updateAllowlist / addAgent /
 * removeAgent).
 */
function cloneConfig(c: BridgeConfig): BridgeConfig {
  return {
    agents: c.agents.map((a) => ({
      ...a,
      allowed_users: [...a.allowed_users],
      spawn: { command: a.spawn.command, args: [...a.spawn.args] },
    })),
    session: { ...c.session },
  };
}

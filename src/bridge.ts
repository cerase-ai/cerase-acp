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
//   - `bridgeE2eTest: false` (production) → no test server; each
//     adapter.start() runs in its own try/catch too, and one failure
//     leaves the other channels serving. runBridge rejects in a single
//     case: no adapter started AND no internal server is configured, so
//     nothing would be left to report the reason. See the total-failure
//     block near the end of runBridge.

import { AdapterSupervisor } from "./adapter-supervisor.js";
import { isAllowed } from "./allowlist.js";
import {
  applyApprovalLink,
  applyApprovalLinkFallback,
  fetchPendingApprovalLink,
  needsApprovalLink,
} from "./approval-link.js";
import { AttachOutcomeTracker } from "./attach-outcome.js";
import { hasAttachments, parseAttachments } from "./attachment.js";
import { type ChatAdapter, createChatAdapter, type DeliveryResult } from "./chat-adapter.js";
import type { AgentConfig, BridgeConfig } from "./config.js";
import { type ConfigDiff, diffConfigs } from "./config-diff.js";
import { ConfigReloader } from "./config-reloader.js";
import { type CredentialRejection, classifyCredentialRejection } from "./credential-rejection.js";
import { checkTenantCredit } from "./credit-check.js";
import { Dispatcher } from "./dispatcher.js";
import { isInternalSummaryBlock, redactEngineIdentifiers, stripToolCallArtifacts } from "./egress-redaction.js";
import { type AgentFailure, type AgentLiveness, type InternalServer, startInternalServer } from "./internal-server.js";
import { makeLogger } from "./logger.js";
import {
  attachmentFailedNotice,
  attachmentsUnsupportedNotice,
  attachmentUnreadableNotice,
  displayFileName,
} from "./platform-notices.js";
import { SessionManager } from "./session-manager.js";
import { postSessionSummary } from "./session-summary.js";
import { startTestInjectionServer, type TestInjectionServer } from "./test-injection.js";
import { fetchTurnContext, formatWallClock } from "./turn-context.js";
import { TurnMetaTracker } from "./turn-meta.js";
import { readAgentWorkspaceFile } from "./workspace-files.js";

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
  /**
   * Starts one adapter and reports whether it came up, swallowing the failure
   * rather than throwing. runBridge supplies the same function its boot loop
   * uses: it folds the outcome into the liveness snapshot AND hands a failure
   * to the retry supervisor, so a transient failure here is retried and a
   * refused credential here is terminal — the two answers the boot path gives,
   * from the same mechanism rather than a second one written here.
   *
   * Optional so the unit tests can drive applyConfigDiff without the bridge;
   * absent → a plain start() with no status record and no retry.
   */
  startAdapter?: (adapter: ChatAdapter) => Promise<boolean>;
  /**
   * Called for every agent this reload removed, after its adapter is stopped
   * and dropped. runBridge wires it to the supervisor so a retry armed for
   * that agent is cancelled: firing it would start an adapter the bridge no
   * longer holds, and nothing would ever stop it.
   */
  forgetAgent?: (agentId: string) => void;
}

/**
 * Bounded-retry adapter creation: one agent's bad token / transient
 * platform error must not abort the whole reload — the remaining agents
 * must still be processed. One retry, then give up on THAT agent and
 * continue; the failure is logged loudly (a missing adapter surfaces via
 * the reload-status path).
 */
async function createAdapterWithRetry(deps: ApplyConfigDiffDeps, agent: AgentConfig): Promise<ChatAdapter | null> {
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
export async function applyConfigDiff(diff: ConfigDiff, deps: ApplyConfigDiffDeps): Promise<void> {
  // Without the bridge's version there is no supervisor and no liveness
  // snapshot to fold an outcome into, so this is just a start() that reports
  // instead of throwing. It is what the standalone unit tests run against.
  const startAdapter =
    deps.startAdapter ??
    (async (adapter: ChatAdapter): Promise<boolean> => {
      try {
        await adapter.start();
        return true;
      } catch (err) {
        // One agent's failure must not abort the reload for the rest, which
        // is why this reports rather than throws.
        logger.error({ err, agentId: adapter.agentId }, "auto-reload: adapter.start() failed");
        return false;
      }
    });

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
    deps.forgetAgent?.(id);
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
          logger.error({ err, agentId: mod.agentId }, "auto-reload: adapter.stop() failed during respawn");
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
        // The failure is reported by whoever owns the start: the bridge's
        // version logs it and decides between a retry and a terminal record.
        // The line that used to be here said the agent would not receive DMs,
        // which a scheduled retry makes untrue.
        if (await startAdapter(adapter)) {
          logger.info({ agentId: mod.agentId, classification: mod.classification }, "auto-reload: agent respawned");
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
    if (await startAdapter(adapter)) {
      logger.info({ agentId: agent.id }, "auto-reload: new agent attached");
    }
  }
}

export interface RunBridgeHandle {
  /** Set only when bridgeE2eTest=true. */
  testInjectionUrl?: string;
  /**
   * Base URL of the internal server (`/internal/inject`, `/internal/status`,
   * `/healthz`). Set only when the internal secret is configured. Lets tests
   * drive the production inject/status path on the ephemeral port.
   */
  internalUrl?: string;
  shutdown(): Promise<void>;
}

export async function runBridge(opts: RunBridgeOptions): Promise<RunBridgeHandle> {
  const { config, bridgeE2eTest } = opts;
  const createAdapter = opts.createAdapter ?? createChatAdapter;

  const sessionManager = new SessionManager(config);
  const turnMeta = new TurnMetaTracker();
  // Shared by the send path (which records) and the production dispatcher
  // (which reads at the end of the turn). Only the production dispatcher has
  // an attach path to record from.
  const attachOutcomes = new AttachOutcomeTracker();

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
    attachOutcomes,
    // Proactive out-of-credits gate. Wired only when the
    // control-plane internal bearer is configured (same secret as
    // session-summary; without it there's nothing to authenticate with).
    // Unset → the dispatcher's back-compat path proceeds as before.
    // checkTenantCredit throws on any non-402/200 or network error, and the
    // dispatcher fails open on a throw — a control-plane glitch must not block
    // chat.
    creditCheck: controlPlaneSecret
      ? (agentId) => checkTenantCredit(agentId, { controlPlaneUrl, internalSecret: controlPlaneSecret })
      : undefined,
    // The organization's wall clock, and the pair's last turn when this
    // process has just started and remembers nobody. Wired on the same
    // condition as the gate above and for the same reason: without the
    // internal bearer there is nothing to authenticate with.
    //
    // The platform comes from the agent's own configuration rather than from
    // the message, because the control-plane stores a channel identity per
    // platform and matching on the id alone would collide the day two
    // platforms hand out the same string.
    turnContext: controlPlaneSecret
      ? async (agentId, userId) => {
          const platform = config.agents.find((a) => a.id === agentId)?.channel;
          const ctx = await fetchTurnContext(
            agentId,
            { platform, platformUserId: userId },
            { controlPlaneUrl, internalSecret: controlPlaneSecret },
          );
          return { clock: formatWallClock(Date.now(), ctx.timezone), lastTurnAt: ctx.lastTurnAt };
        }
      : undefined,
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
      // The wrapper forwards the inner adapter's DeliveryResult so a
      // swallowed send failure can surface; a fully suppressed chunk
      // (attachment-only, internal summary, DSML) reports `{ ok: true }`
      // because there was nothing left to deliver.
      return async (chunk: string): Promise<DeliveryResult> => {
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
            // Fetch failed (≠ no pending approval) — explain
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
        // The files this reply carries, held until the sentence introducing
        // them has been sent. Uploading first put the file ABOVE the words
        // "here it is", so a reader met a bare attachment and then the
        // explanation for it. The text cannot simply be sent here instead:
        // every filter below it -- the internal-summary suppression, the
        // engine-identity redaction, the tool-call stripping -- runs after this
        // point, and sending ahead of them would put unredacted text in the
        // chat. So the upload moves down rather than the text moving up.
        let deliverAttachments = async (): Promise<void> => {};

        if (hasAttachments(text)) {
          const parsed = parseAttachments(text);
          const containerName = `cerase-${agentId}`;
          // The upload happens after the model has finished writing, so it
          // cannot report the outcome itself -- the assistant's baseline is
          // explicit that it must not claim delivery. That makes THIS the only
          // place the reader can learn an attachment did not arrive, and a
          // silent log left them with a reply promising a file and no file.
          //
          // Every failure below is also recorded against the turn, which is
          // what stops the same turn from closing as a success: a notice in
          // the chat is read by the person, and until it was recorded nothing
          // else in the process knew the file had not gone.
          const lang = turnMeta.languageFor(agentId, userId);
          const relPaths = parsed.attachments;
          deliverAttachments = async () => {
            for (const relPath of relPaths) {
              const fileName = displayFileName(relPath);
              try {
                const file = await readAgentWorkspaceFile(containerName, relPath);
                if (adapter.sendFile) {
                  const fileResult = await adapter.sendFile(userId, { name: file.name, bytes: file.bytes });
                  if (!fileResult.ok) {
                    logger.warn({ err: fileResult.error, agentId, relPath }, "attach: sendFile reported failure");
                    await inner(attachmentFailedNotice(file.name, lang));
                    attachOutcomes.record(agentId, userId, {
                      fileName: file.name,
                      reason: `the channel refused the upload: ${fileResult.error?.message ?? "no reason given"}`,
                    });
                  }
                } else {
                  await inner(attachmentsUnsupportedNotice(file.name, lang));
                  attachOutcomes.record(agentId, userId, {
                    fileName: file.name,
                    reason: "this channel cannot carry attachments at all",
                  });
                }
              } catch (err) {
                logger.warn({ err, agentId, relPath }, "attach: failed to read/send workspace file");
                await inner(attachmentUnreadableNotice(fileName, lang));
                attachOutcomes.record(agentId, userId, {
                  fileName,
                  reason: err instanceof Error ? err.message : String(err),
                });
              }
            }
          };
          text = parsed.text;
          // If the reply was only the marker, don't send an empty message —
          // the attachment(s) are the whole reply, and nothing introduces them.
          if (!text) {
            await deliverAttachments();

            return { ok: true };
          }
        }
        // The engine's internal context-compaction summary block (session
        // state / next actions / workspace paths, and any masked PII token
        // inside it) must never be user-facing. If this reply is that block,
        // withhold it entirely — it is not an answer.
        if (isInternalSummaryBlock(text)) {
          logger.warn({ agentId }, "egress: suppressed an internal engine summary/compaction block");
          // Capture it instead of discarding — persist as the assistant's
          // rolling summary over the internal channel. Fire-and-forget; a
          // capture failure must not affect the turn.
          if (controlPlaneSecret) {
            void postSessionSummary(agentId, text, {
              controlPlaneUrl,
              internalSecret: controlPlaneSecret,
            }).catch((err) => {
              logger.warn({ err, agentId }, "postSessionSummary failed (fire-and-forget)");
            });
          }
          await deliverAttachments();

          return { ok: true };
        }
        // Deterministic engine-identity redaction, the last step before the
        // reply leaves for any channel — never reveal we run on OpenCode,
        // even if the model ignored the prompt-level rule.
        text = redactEngineIdentifiers(text);
        // A tool call the model spelled out as text (DSML) must never reach
        // the chat. Strip it; if that was the whole reply, withhold it (it is
        // scaffolding, not an answer).
        text = stripToolCallArtifacts(text);
        if (!text.trim()) {
          logger.warn({ agentId }, "egress: suppressed a malformed tool-call (DSML) artifact");
          await deliverAttachments();

          return { ok: true };
        }
        const textResult = await inner(text);
        // After the text, always. A failed text send does not withhold the
        // file: the file is the deliverable, and its own failure has its own
        // notice.
        await deliverAttachments();

        return textResult;
      };
    },
  });

  for (const agent of config.agents) {
    adapters.set(agent.id, await createAdapter(agent, productionDispatcher));
  }

  // agentIds whose most recent start() rejected.
  // Tracked so getAgentStatus reports them ready:false (not null) even for
  // adapters that expose no ready() signal of their own, and so the
  // self-heal supervisor knows which adapters to retry. Cleared on a
  // successful (re)start.
  const startFailures = new Set<string>();

  // agentIds whose channel provider refused their credential. Distinct from
  // startFailures, which holds every kind of failed start: this set is the
  // subset nothing is retrying, because no amount of retrying changes a
  // provider's verdict on a credential. It is what /internal/status reports so
  // the stop is visible; a terminal state nobody can see would replace one
  // invisible failure with another.
  const credentialRejections = new Map<string, CredentialRejection>();

  // Retry a failed channel adapter on a capped, jittered backoff until it
  // connects (no container restart). Production only: in BRIDGE_E2E_TEST mode
  // background retries would interfere with the deterministic test path.
  // Recovery clears the not-ready mark so /internal/status reflects the
  // comeback.
  const supervisor = bridgeE2eTest
    ? undefined
    : new AdapterSupervisor({
        baseDelayMs: Number(process.env.CERASE_ACP_ADAPTER_RETRY_BASE_MS ?? "5000"),
        maxDelayMs: Number(process.env.CERASE_ACP_ADAPTER_RETRY_MAX_MS ?? "300000"),
        onRecovered: (agentId) => {
          startFailures.delete(agentId);
          credentialRejections.delete(agentId);
        },
        onStillFailing: (agentId) => startFailures.add(agentId),
        onTerminal: (agentId, rejection) => {
          startFailures.add(agentId);
          credentialRejections.set(agentId, rejection);
        },
      });

  /**
   * Fold one adapter start outcome into the liveness snapshot. Called from the
   * boot loop and, through applyConfigDiff, from every reload, so the two
   * paths cannot drift into reporting the same agent differently. Returns the
   * refusal when the failure was final, which is how the caller knows not to
   * schedule a retry.
   */
  const recordStartOutcome = (agentId: string, err?: unknown): CredentialRejection | undefined => {
    if (err === undefined) {
      startFailures.delete(agentId);
      credentialRejections.delete(agentId);
      supervisor?.noteStarted(agentId);
      return undefined;
    }
    startFailures.add(agentId);
    const rejection = classifyCredentialRejection(err);
    if (!rejection) {
      credentialRejections.delete(agentId);
      return undefined;
    }
    credentialRejections.set(agentId, rejection);
    logger.error(
      { agentId, code: rejection.code, credential: rejection.credential, detail: rejection.detail },
      "adapter.start() failed: the channel provider refused this agent's credential — not retrying, this assistant is DOWN until the credential is fixed",
    );
    return rejection;
  };

  /**
   * Start one adapter, and answer its failure. The answer is two decisions —
   * what /internal/status reports, and whether a retry is worth arming — and
   * both belong to whichever path the adapter came through, boot or config
   * reload. They came through separate code, so the reload path reported a
   * failure and then dropped it: no retry, and a token corrected while the
   * provider was having a bad minute stayed down until someone restarted the
   * container. This is that code, once, for both callers.
   *
   * Never throws: a caller loops over adapters, and one failure must not stop
   * it starting the rest. Returns whether the adapter came up.
   */
  const startAdapter = async (adapter: ChatAdapter): Promise<boolean> => {
    try {
      await adapter.start();
      recordStartOutcome(adapter.agentId);
      return true;
    } catch (err) {
      // A refused credential is already recorded and already logged by
      // recordStartOutcome. Retrying it would re-ask a question the provider
      // has answered, and the loop would read as recovery in progress.
      if (recordStartOutcome(adapter.agentId, err)) return false;
      logger.error(
        { err, agentId: adapter.agentId },
        "adapter.start() failed — this channel is DOWN; other channels stay up",
      );
      supervisor?.scheduleRetry(adapter, err);
      return false;
    }
  };

  /**
   * The `failure` block for one agent, or nothing when it has none. Split out
   * so the two sources are ordered in one place instead of nested inside the
   * snapshot literal.
   */
  const failureBlockFor = (id: string): { failure?: AgentFailure } => {
    const rejected = credentialRejections.get(id);
    if (rejected) return { failure: { kind: "credential_rejected", ...rejected } };
    const modeMissing = sessionManager.sessionModeFailure(id);
    if (modeMissing) {
      return {
        failure: {
          kind: "session_mode_missing",
          mode: modeMissing.requested,
          available: modeMissing.available,
          detail: modeMissing.detail,
        },
      };
    }
    return {};
  };

  // The live per-agent liveness snapshot served by GET /internal/status.
  // Source of truth = the `adapters` map (an agent dropped from agents.yaml
  // is gone from here → the control-plane reads it as "Disconnesso"); the
  // channel is joined from the live config and `ready` delegates to the
  // adapter's own connection check.
  const getAgentStatus = (): AgentLiveness[] =>
    Array.from(adapters.entries()).map(([id, adapter]) => ({
      id,
      channel: config.agents.find((a) => a.id === id)?.channel ?? "unknown",
      attached: true,
      // Present only for a failure that will not resolve itself, and it names
      // the credential rather than only the symptom: an operator reading this
      // has to know which value to replace, on which agent.
      //
      // A refused credential is reported ahead of a missing session mode when
      // both are known. The channel is the outer of the two: with it down no
      // message reaches the assistant at all, so the mode it would have run
      // under is not what a person should be sent to fix first.
      ...failureBlockFor(id),
      // An adapter whose start() failed is concretely not-ready — report
      // `false`, never `null`, so the control-plane shows it Disconnesso
      // rather than "stato sconosciuto". Otherwise this was `: true` — a
      // hard-coded green for every adapter that doesn't implement ready()
      // (telegram/slack/workspace), so a gateway drop on those channels
      // showed as healthy. Report `null` (unknown) instead; only adapters
      // with a real readiness signal (discord.js client.isReady()) report a
      // concrete boolean.
      ready: startFailures.has(id) ? false : adapter.ready ? adapter.ready() : null,
      // How long since the channel provider actually answered this adapter.
      // `ready` above already folds it in, so this is the reader's way of
      // telling the two down-states apart: a client that knows it dropped, and
      // a client that believes a dead socket is alive. Null on a channel that
      // measures nothing, which is every channel but Discord today.
      lastContactAgeMs: adapter.reachability ? adapter.reachability().ageMs : null,
    }));

  // Productionised injection endpoint the control-plane scheduled-message
  // dispatcher POSTs to (shared-secret). Started when the internal secret is
  // configured; the read-only GET /internal/status liveness probe runs on
  // the same server.
  let internalServer: InternalServer | undefined;
  if (acpInjectSecret) {
    internalServer = await startInternalServer({
      dispatcher: productionDispatcher,
      internalSecret: acpInjectSecret,
      port: Number(process.env.CERASE_ACP_INTERNAL_PORT ?? "7476"),
      getAgentStatus,
      // Gate inject on the agent's allowlist (unknown agent → reject).
      isAllowed: (agentId, userId) => {
        try {
          return isAllowed(config, agentId, userId);
        } catch {
          return false;
        }
      },
    });
    logger.info({ port: internalServer.port() }, "internal endpoints started (/internal/inject, /internal/status)");
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
      resolveSendTarget:
        (agentId, userId) =>
        async (chunk): Promise<DeliveryResult> => {
          serverRef?.recordReply(agentId, userId, chunk);
          return { ok: true };
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

  // Start each adapter independently. A single adapter's start() failure
  // (e.g. a bad Discord token → TokenInvalid) is logged + recorded in
  // `startFailures` but does not tear the bridge down: the internal-server,
  // the panel-only `web` maintainer transport, and the other healthy
  // adapters all stay up. This holds in both modes — the only historical
  // difference (test-mode swallowed, production fanned-out-and-rethrew) was
  // exactly the crash-loop bug that took the web/maintainer chat down
  // whenever the Discord token was invalid.
  //
  // What happens when EVERY adapter failed is decided after the loop; see the
  // total-failure block below. In test-mode nothing is ever thrown (the
  // test-injection server must stay reachable even with all-fake tokens).
  let started = 0;
  for (const adapter of adapters.values()) {
    if (await startAdapter(adapter)) started += 1;
  }
  // Total failure: not one adapter came up, so no message reaches any
  // assistant. What that should do depends on whether anything is listening
  // to be asked why.
  //
  // With the internal server up, staying alive is the better answer. Exiting
  // took down the only endpoint that could name the refused credential and
  // handed the orchestrator a container to restart, which restarts into the
  // same refusal: a crash-loop with no reason attached, which is the failure
  // shape this bridge reports everywhere else. It also cancelled the retry
  // timers, so a transient failure — a gateway 5xx, a connect timeout — became
  // permanent on any box whose adapters all happened to be failing at once. A
  // box with one assistant is every box in that condition.
  //
  // Staying up must not be mistaken for working. The bridge does nothing in
  // this state, so it declares itself: GET /healthz answers 503 while no
  // adapter can carry a message (the compose healthcheck reads the status
  // code, so the container shows unhealthy), and /internal/status carries the
  // per-agent failure block naming what to fix.
  //
  // Without the internal server there is no endpoint and no probe, and a
  // silent process the orchestrator reads as running says less than a restart
  // loop does. So that configuration keeps the exit.
  const noTransport = !bridgeE2eTest && adapters.size > 0 && started === 0;
  if (noTransport && !internalServer) {
    logger.error(
      { agentCount: adapters.size },
      "every adapter failed to start and no internal endpoint is configured — nothing could report the reason, tearing down",
    );
    supervisor?.stop();
    await Promise.allSettled([...Array.from(adapters.values()).map((a) => a.stop()), sessionManager.shutdown()]);
    throw new Error("all chat adapters failed to start");
  }
  if (noTransport) {
    logger.error(
      { agentCount: adapters.size },
      "every adapter failed to start — the bridge stays up to report it and carries no chat traffic; /healthz answers 503 and /internal/status names each agent's failure",
    );
  }

  logger.info(
    { agentCount: adapters.size, startedCount: started, bridgeE2eTest },
    noTransport ? "cerase-acp bridge up with no working chat transport" : "cerase-acp bridge ready",
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
      if (diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0) {
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
        startAdapter,
        forgetAgent: (agentId) => supervisor?.cancel(agentId),
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
    internalUrl: internalServer ? `http://127.0.0.1:${internalServer.port()}` : undefined,
    async shutdown() {
      // Order: stop reloader + self-heal supervisor → stop discord clients →
      // close test server → kill ACP children. Reverse of startup so
      // dependents go first; stopping the supervisor first prevents a retry
      // racing the teardown.
      if (reloader) reloader.stop();
      supervisor?.stop();
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

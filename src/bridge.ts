// runBridge — wires config → session-manager + turn-meta + per-agent
// adapter table + dispatcher + adapter retry supervisor + internal server +
// config reloader, and (optionally) the BRIDGE_E2E_TEST HTTP server. Kept
// apart from index.ts so tests can drive it with a fake adapter factory (no
// real channel logins).
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
import { parseAttachments } from "./attachment.js";
import { type ChatAdapter, createChatAdapter, type DeliveryResult } from "./chat-adapter.js";
import type { AgentConfig, BridgeConfig } from "./config.js";
import { type ConfigDiff, diffConfigs } from "./config-diff.js";
import { ConfigReloader } from "./config-reloader.js";
import { type CredentialRejection, classifyCredentialRejection } from "./credential-rejection.js";
import { checkTenantCredit } from "./credit-check.js";
import { Dispatcher, STOP_DRAIN_MS, STOP_NOTICE_MS } from "./dispatcher.js";
import { isInternalSummaryBlock, redactEngineIdentifiers, stripToolCallArtifacts } from "./egress-redaction.js";
import { requestFileLink } from "./file-link.js";
import { postInjectOutcome } from "./inject-outcome.js";
import { type AgentFailure, type AgentLiveness, type InternalServer, startInternalServer } from "./internal-server.js";
import { KeptReplies } from "./kept-replies.js";
import { makeLogger } from "./logger.js";
import { isNoSharedServer } from "./no-shared-server.js";
import { PendingMessages, replayPending } from "./pending-messages.js";
import {
  attachmentFailedNotice,
  attachmentUnreadableNotice,
  displayFileName,
  fileLinkNotice,
  unnamedFile,
} from "./platform-notices.js";
import { fetchRecentConversation } from "./recent-conversation.js";
import { SessionManager } from "./session-manager.js";
import { fetchSessionSummary, postSessionSummary } from "./session-summary.js";
import { startTestInjectionServer, type TestInjectionServer } from "./test-injection.js";
import { fetchToolStep } from "./tool-step.js";
import { fetchTurnContext, formatWallClock } from "./turn-context.js";
import { TurnMetaTracker } from "./turn-meta.js";
import { requestVoiceTranscript } from "./voice-transcript.js";
import { readAgentWorkspaceFile } from "./workspace-files.js";

const logger = makeLogger("cerase-acp.bridge");

/**
 * How often, while a reply is kept, the bridge asks whether its channel can
 * carry it now, in ms. A channel that comes back with a start is sent to at
 * once; this is for one whose client reconnects by itself.
 */
export const KEPT_REPLY_POLL_MS = 5_000;

/**
 * How often, while Discord refuses DMs to a person with 50278, the bridge
 * tries again a reply kept for them anyway. A new message from the person is
 * attempted at once; this is for a kept reply with no new message to learn
 * from, and it is sparse because the only way to learn that person is
 * reachable is to send, and each attempt meets the same refusal until
 * somebody adds the bot to their server. The variable
 * `CERASE_ACP_NO_SERVER_RETRY_MS` overrides it for tests.
 */
export const NO_SHARED_SERVER_RETRY_MS = 60_000;

export interface RunBridgeOptions {
  config: BridgeConfig;
  bridgeE2eTest: boolean;
  /** Port for the test-injection server (only when bridgeE2eTest=true). Defaults to 7474; tests pass 0. */
  testInjectionPort?: number;
  /**
   * Adapter factory for dependency injection in tests. Defaults to the
   * real cross-channel factory (`createChatAdapter`), which dispatches
   * on `agent.channel`. Returns a Promise to support lazy-loading of
   * the per-channel transport library (discord.js / telegraf / @slack/bolt
   * / google-auth-library). Tests typically supply a synchronous fake and
   * wrap it in Promise.resolve.
   */
  createAdapter?: (agent: AgentConfig, dispatcher: Dispatcher) => Promise<ChatAdapter>;
  /**
   * Path of the agents.yaml the bridge should watch for live updates. When
   * set, runBridge instantiates a ConfigReloader; on each successful reload
   * the diff is applied to the live adapters table + SessionManager.
   * Unset → no watcher. index.ts always sets it.
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
  replaceAgent(agent: AgentConfig): void;
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
  /**
   * Called for every adapter this reload creates, before it is started. The
   * boot path calls the same wiring: runBridge registers the adapter's
   * onReachable listener and drops the no-shared-server marks left by the
   * adapter it replaces, which described a bot that is gone. Optional so the
   * unit tests can drive applyConfigDiff without the bridge.
   */
  onAdapterCreated?: (adapter: ChatAdapter) => void;
}

/**
 * Bounded-retry adapter creation: one agent's bad token / transient
 * platform error must not abort the whole reload — the remaining agents
 * must still be processed. One retry, then give up on THAT agent and
 * continue; the failure is logged loudly, and the agent is absent from
 * /internal/status until a later reload creates its adapter.
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
      const fresh = deps.next.agents.find((a) => a.id === mod.agentId);
      if (fresh) {
        // One object for the session manager and the new adapter. Each reads
        // the allowlist from the agent it holds, and an allowed_users_only
        // reload later updates the session manager's copy in place: with two
        // copies that update reaches only one of them, and an address added
        // in the console is refused by the channel that should route it.
        // Replacing also ends the old sessions, so the next one spawns under
        // the reloaded command and mode.
        deps.sessionManager.replaceAgent(fresh);

        const adapter = await createAdapterWithRetry(deps, fresh);
        if (!adapter) continue; // skip this agent, keep reloading the rest
        deps.adapters.set(mod.agentId, adapter);
        deps.onAdapterCreated?.(adapter);
        // The failure is reported by whoever owns the start: the bridge's
        // version logs it and decides between a retry and a terminal record.
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
    if (!adapter) continue; // skip this agent, keep reloading the rest
    deps.adapters.set(agent.id, adapter);
    deps.onAdapterCreated?.(adapter);
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

  // The state directory the image sets, where the bridge keeps what it needs
  // across a restart of its own. Unset outside the image, which keeps all of
  // it in memory.
  const stateDir = process.env.CERASE_ACP_STATE_DIR;
  const sessionManager = new SessionManager(config, undefined, { stateDir });
  // Messages that arrive while the bridge stops, kept for the next one.
  const pendingMessages = new PendingMessages(stateDir);
  // Replies the agent's channel could not carry when they were written, kept
  // until it can: see kept-replies.ts.
  const keptReplies = new KeptReplies(stateDir);
  const turnMeta = new TurnMetaTracker();
  // Shared by the send path (which records) and the production dispatcher
  // (which reads at the end of the turn). Only the production dispatcher has
  // an attach path to record from.
  const attachOutcomes = new AttachOutcomeTracker();

  // Two dispatchers share SessionManager + TurnMetaTracker but differ
  // in send-target: the production one routes replies through the agent's
  // channel adapter; the test-injection one records them in the test
  // server's recordReply table, so /_test/last-reply answers whether or not
  // the agent's channel has a working login.

  // Build the adapter table BEFORE the production dispatcher so
  // resolveSendTarget can look up the right adapter. Map is shared by
  // both dispatchers (production + test-mode) below.
  const adapters = new Map<string, ChatAdapter>();

  // The control-plane's internal API: credit check, turn context, approval
  // link, rolling summaries and the sentences of the status line.
  const controlPlaneUrl = process.env.CERASE_CONTROL_PLANE_URL ?? "http://cerase-control-plane:8000";
  // Two distinct secrets:
  //  - controlPlaneSecret(): the CONTROL-PLANE internal bearer — to CALL
  //    control-plane internal endpoints. The control-plane writes it into
  //    agents.yaml (`internal_bearer`) and a reload replaces it, so it is read
  //    at every call; CERASE_INTERNAL_SECRET is the fallback for a bridge run
  //    outside the appliance. Until 7 October nothing on a box set either, and
  //    every call below was left unwired without a word: no turn carried the
  //    clock. A call made without one now fails, and the failure is logged.
  //  - acpInjectSecret: the bearer the bridge's own internal endpoints
  //    (/internal/inject, /internal/status) require; unset, the internal
  //    server does not start. Must match the control-plane's
  //    cerase.acp.internal_secret.
  const controlPlaneSecret = (): string => config.internal_bearer || process.env.CERASE_INTERNAL_SECRET || "";
  const requireControlPlaneSecret = (): string => {
    const secret = controlPlaneSecret();
    if (!secret) throw new Error("no control-plane bearer: agents.yaml carries no internal_bearer");
    return secret;
  };
  const acpInjectSecret = process.env.CERASE_ACP_INTERNAL_SECRET ?? "";

  // A withheld internal summary is kept rather than discarded: posted over the
  // internal channel as the assistant's rolling summary. Fire-and-forget; a
  // capture failure must not affect the turn. Called from the send path below
  // for a summary withheld whole, and by the dispatcher for one it held back
  // while it streamed in pieces.
  const captureSummary = (agentId: string, summary: string): void => {
    const secret = controlPlaneSecret();
    if (!secret) {
      logger.warn({ agentId }, "a withheld summary was not kept: agents.yaml carries no internal_bearer");
      return;
    }
    void postSessionSummary(agentId, summary, {
      controlPlaneUrl,
      internalSecret: secret,
    }).catch((err) => {
      logger.warn({ err, agentId }, "postSessionSummary failed (fire-and-forget)");
    });
  };

  /**
   * Whether an agent's channel can carry a message now, through `through` when
   * one is named: the agent's adapter is that one, its last start did not fail,
   * and it does not report itself down. An adapter with no readiness of its own
   * is taken at its start.
   */
  const channelCanCarry = (agentId: string, through?: ChatAdapter): boolean => {
    const current = adapters.get(agentId);
    if (!current || (through !== undefined && current !== through)) return false;
    if (startFailures.has(agentId)) return false;
    return current.ready ? current.ready() : true;
  };

  /** A chunk with `{{APPROVAL_LINK}}` replaced, as it is sent now or kept for later. */
  const withApprovalLink = async (agentId: string, chunk: string): Promise<string> => {
    // Substitute {{APPROVAL_LINK}} in outgoing chunks with the signed link
    // (fetched over the internal channel — never given to the agent). Only acts
    // on chunks carrying the placeholder, so the common path pays no extra HTTP.
    // Done before a reply is kept, so a kept reply carries the link of the
    // approval it was written about rather than of the one pending when the
    // channel is back.
    if (!needsApprovalLink(chunk)) return chunk;
    try {
      const link = await fetchPendingApprovalLink(agentId, {
        controlPlaneUrl,
        internalSecret: requireControlPlaneSecret(),
      });
      return applyApprovalLink(chunk, link);
    } catch (err) {
      // Fetch failed (≠ no pending approval) — explain
      // instead of silently stripping the placeholder.
      logger.warn({ err, agentId }, "approval-link fetch failed — substituting fallback note");
      return applyApprovalLinkFallback(chunk);
    }
  };

  /**
   * The send path of one person's chunks after the approval link, through
   * `adapter`: the files a chunk names, the filters, and the channel. The send
   * target is made once, here, because a channel may hand each turn something
   * of its own through it (Workspace Chat's placeholder).
   *
   * It forwards the adapter's DeliveryResult so a swallowed send failure can
   * surface. A chunk that was only files reports `{ ok: true }`: the files are
   * the reply. A chunk withheld whole as an internal summary or as tool-call
   * markup reports `withheld`, so the dispatcher knows the person received
   * nothing.
   */
  const sendThrough = (adapter: ChatAdapter, agentId: string, userId: string) => {
    const inner = adapter.makeSendTarget(userId);
    return async (chunk: string): Promise<DeliveryResult> => {
      let text = chunk;
      // Upload workspace files referenced by [[attach: <path>]].
      // The agent emits the marker; we read the file from its slot
      // container's workspace and send it as a channel attachment, never
      // showing the raw marker. Container name follows the cerase-<id>
      // convention (agents.yaml id `agent-1` → container `cerase-agent-1`).
      //
      // The sentence that introduces a file is the file's caption when the
      // channel declares a caption limit and the sentence fits within it: the
      // first file then carries the text in the one message the file already
      // is, so the reader meets the words and the file together. A text too
      // long to be a caption, or a channel with no caption limit, keeps the
      // older order -- the text as its own message, the files bare after it.
      // The text is not sent here either way: every filter below -- the
      // internal-summary suppression, the engine-identity redaction, the
      // tool-call stripping -- runs after this point, and a caption built
      // ahead of them could put unredacted text in the chat. The caption is
      // therefore chosen once they have all run, on the same text the channel
      // would otherwise have received.
      let deliverAttachments = async (_caption?: string): Promise<DeliveryResult | undefined> => undefined;
      // What a chunk withheld whole reports: delivered when it carried files,
      // which are an answer of their own, and withheld when it did not.
      let withheldWhole: DeliveryResult = { ok: true, withheld: true };

      const parsed = parseAttachments(text);
      if (parsed.text !== text) {
        const containerName = `cerase-${agentId}`;
        // The upload happens after the model has finished writing, so it
        // cannot report the outcome itself -- the assistant's baseline is
        // explicit that it must not claim delivery. The person learns here
        // that an attachment did not arrive. Every failure below is also
        // recorded against the turn, which is what stops the same turn from
        // closing as a success.
        const lang = turnMeta.languageFor(agentId, userId);
        const relPaths = parsed.attachments;
        const refused = parsed.refused;
        deliverAttachments = async (caption?: string): Promise<DeliveryResult | undefined> => {
          // A marker that names nothing the bridge may read promised the
          // person a file all the same, and is reported as one that could
          // not be read.
          for (const marker of refused) {
            const fileName = marker.name || unnamedFile(lang);
            logger.warn({ agentId, reason: marker.reason }, "attach: a marker named no file that can be sent");
            await inner(attachmentUnreadableNotice(fileName, lang));
            attachOutcomes.record(agentId, userId, { fileName, reason: marker.reason });
          }
          // What the text send answered when a refused caption fell back to it:
          // the caller returns it, so a channel that also went down lets the
          // whole reply be kept, files and all.
          let captionFallback: DeliveryResult | undefined;
          // The channel cannot carry this file itself, so it reaches the
          // person as a control-plane link instead. A link is a delivery, not
          // a lost attachment: nothing is recorded unless asking for it fails.
          const linkInsteadOfUpload = async (fileName: string, relPath: string): Promise<void> => {
            try {
              const link = await requestFileLink(agentId, relPath, {
                controlPlaneUrl,
                internalSecret: requireControlPlaneSecret(),
              });
              await inner(fileLinkNotice(link.name, link.url, link.expiresAt, lang));
            } catch (err) {
              logger.warn({ err, agentId, relPath }, "attach: the control-plane refused a file link");
              await inner(attachmentFailedNotice(fileName, lang));
              attachOutcomes.record(agentId, userId, {
                fileName,
                reason: `the control-plane refused a link: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
          };
          for (const [index, relPath] of relPaths.entries()) {
            const fileName = displayFileName(relPath);
            try {
              const file = await readAgentWorkspaceFile(containerName, relPath);
              if (adapter.sendFile) {
                // Only the first file may carry the text: a caption on a second
                // would repeat the sentence under a file it already introduced.
                const fileCaption = index === 0 ? caption : undefined;
                const fileResult = await adapter.sendFile(userId, {
                  name: file.name,
                  bytes: file.bytes,
                  ...(fileCaption !== undefined ? { caption: fileCaption } : {}),
                });
                if (!fileResult.ok) {
                  // The caption was the only copy of the words, so a refused
                  // upload has to deliver them as their own message, before
                  // the person is told how the file went.
                  if (fileCaption !== undefined) captionFallback = await inner(fileCaption);
                  if (fileResult.linkInstead) {
                    // The channel could not carry the file but the bridge has
                    // it whole, so the link is the delivery and the failed
                    // upload is not recorded as one.
                    await linkInsteadOfUpload(file.name, relPath);
                  } else {
                    logger.warn({ err: fileResult.error, agentId, relPath }, "attach: sendFile reported failure");
                    await inner(attachmentFailedNotice(file.name, lang));
                    attachOutcomes.record(agentId, userId, {
                      fileName: file.name,
                      reason: `the channel refused the upload: ${fileResult.error?.message ?? "no reason given"}`,
                    });
                  }
                }
              } else {
                // An adapter with no upload at all still reaches the person,
                // through a link the control-plane serves.
                await linkInsteadOfUpload(file.name, relPath);
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
          return captionFallback;
        };
        text = parsed.text;
        if (relPaths.length > 0 || refused.length > 0) withheldWhole = { ok: true };
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
        // Capture it instead of discarding it.
        captureSummary(agentId, text);
        await deliverAttachments();

        return withheldWhole;
      }
      // Deterministic engine-identity redaction — never reveal we run on
      // OpenCode, even if the model ignored the prompt-level rule.
      text = redactEngineIdentifiers(text);
      // A tool call the model spelled out as text (DSML) must never reach
      // the chat. Strip it; if that was the whole reply, withhold it (it is
      // scaffolding, not an answer).
      text = stripToolCallArtifacts(text);
      if (!text.trim()) {
        logger.warn({ agentId }, "egress: suppressed a malformed tool-call (DSML) artifact");
        await deliverAttachments();

        return withheldWhole;
      }
      // The caption path: when the chunk names at least one file, the channel
      // declares a caption limit that takes no more than the filtered text, and
      // that text is non-empty and within the limit, the first file carries the
      // text and the chunk goes out as that one message. The text is not sent
      // through `inner` then, so the sentence is not repeated ahead of the file
      // it introduces.
      const captionLimit = adapter.captionLimit;
      const caption =
        parsed.attachments.length > 0 &&
        adapter.sendFile !== undefined &&
        captionLimit !== undefined &&
        text.length > 0 &&
        text.length <= captionLimit
          ? text
          : undefined;
      if (caption !== undefined) {
        // The file send's own failure notice is handled inside; what it returns
        // is the text send's outcome only when a refused caption had to fall
        // back to it.
        return (await deliverAttachments(caption)) ?? { ok: true };
      }
      const textResult = await inner(text);
      // A text the channel refused because it is down is kept whole, files
      // and all, and the files go with it when it is sent again: see
      // `resolveSendTarget`.
      if (!textResult.ok && !channelCanCarry(agentId, adapter)) return textResult;
      // After the text, always. A failed text send does not withhold the
      // file: the file is the deliverable, and its own failure has its own
      // notice.
      await deliverAttachments();

      return textResult;
    };
  };

  // The people each agent's bot cannot DM because Discord answers 50278: the
  // bot shares no server with them. Kept per agent because the bot is what
  // lacks the server, and reported on /internal/status until a send to that
  // person succeeds or the adapter says it can reach people again. The value
  // is when the person was last marked, which paces the kept-reply retries.
  const noSharedServerMarks = new Map<string, Map<string, number>>();
  const noServerRetryEnv = Number(process.env.CERASE_ACP_NO_SERVER_RETRY_MS?.trim() || "");
  const noServerRetryMs =
    Number.isFinite(noServerRetryEnv) && noServerRetryEnv > 0 ? noServerRetryEnv : NO_SHARED_SERVER_RETRY_MS;

  /** When Discord last refused a DM to this person, or undefined when not marked. */
  const noSharedServerMarkAt = (agentId: string, userId: string): number | undefined =>
    noSharedServerMarks.get(agentId)?.get(userId);

  /** Remember that Discord refused a DM to this person, and say so once. */
  const markNoSharedServer = (agentId: string, userId: string): void => {
    let people = noSharedServerMarks.get(agentId);
    if (!people) {
      people = new Map();
      noSharedServerMarks.set(agentId, people);
    }
    const already = people.has(userId);
    people.set(userId, Date.now());
    // Once per marking, not once per refused attempt: a retried kept reply
    // meets the same verdict and would otherwise fill the log with it.
    if (!already) {
      logger.warn(
        { agentId, userId },
        "Discord refuses DMs to this person: the bot shares no server with them — replies are kept until it does",
      );
    }
  };

  /** The person is reachable again: drop the mark. Answers whether one was held. */
  const clearNoSharedServer = (agentId: string, userId: string): boolean => {
    const people = noSharedServerMarks.get(agentId);
    if (!people?.delete(userId)) return false;
    if (people.size === 0) noSharedServerMarks.delete(agentId);
    return true;
  };

  /** Drop every mark of an agent whose adapter is replaced or removed. */
  const clearNoSharedServerFor = (agentId: string): void => {
    noSharedServerMarks.delete(agentId);
  };

  /**
   * Send what is kept for one person through the agent's adapter, for as long
   * as its channel can carry it. The send target is made only when there is
   * something to send.
   */
  const deliverKept = (agentId: string, userId: string): Promise<number> => {
    const adapter = adapters.get(agentId);
    if (!adapter) return Promise.resolve(0);
    let send: ((text: string) => Promise<DeliveryResult>) | undefined;
    // Set when Discord answered 50278 during this delivery. The reply has
    // already been taken out of the kept list by kept-replies.ts, so the
    // delivery must look like a channel that cannot carry it: that puts the
    // reply back for the next retry instead of dropping it as a message the
    // channel refused while up.
    let noSharedServer = false;
    return keptReplies.deliver(
      agentId,
      userId,
      async (text) => {
        send ??= sendThrough(adapter, agentId, userId);
        const result = await send(text);
        if (result.ok) {
          clearNoSharedServer(agentId, userId);
        } else if (isNoSharedServer(result.error)) {
          markNoSharedServer(agentId, userId);
          noSharedServer = true;
        }
        return result;
      },
      () => !noSharedServer && channelCanCarry(agentId, adapter),
    );
  };

  /** Send what is kept for every person of an agent, when its channel can carry it. */
  const deliverKeptFor = (agentId: string): void => {
    if (!channelCanCarry(agentId)) return;
    const now = Date.now();
    for (const userId of keptReplies.people(agentId)) {
      // A person Discord refuses is retried at most once a minute: sending is
      // the only way to learn they joined a server the bot is in, and until
      // then every attempt is the same refusal. A new message from them, and
      // the adapter's reachability event, do not wait for this.
      const at = noSharedServerMarkAt(agentId, userId);
      if (at !== undefined && now - at < noServerRetryMs) continue;
      deliverKept(agentId, userId).catch((err) => {
        logger.error({ err, agentId, userId }, "sending the kept replies failed");
      });
    }
  };

  /**
   * Keep a chunk the channel cannot carry, and answer the send queue that it
   * is taken care of: the queue has nothing to retry and no failure to report,
   * and the turn has answered the person, who reads the answer once the channel
   * is back. An agent whose adapter was replaced while the chunk was being
   * sent can carry it through the new one at once.
   */
  const keepReply = (agentId: string, userId: string, text: string): DeliveryResult => {
    keptReplies.keep(agentId, userId, text);
    logger.warn(
      { agentId, userId, chars: text.length },
      "the channel cannot carry this reply now — kept, and sent once it can",
    );
    deliverKeptFor(agentId);
    return { ok: true, kept: true };
  };

  const productionDispatcher = new Dispatcher({
    config,
    sessionManager,
    turnMeta,
    attachOutcomes,
    // Proactive out-of-credits gate. Wired only when the
    // control-plane internal bearer is configured (same secret as
    // session-summary; without it there's nothing to authenticate with).
    // Unset → turns run without the check.
    // checkTenantCredit throws on any non-402/200 or network error, and the
    // dispatcher fails open on a throw — a control-plane glitch must not block
    // chat.
    creditCheck: (agentId) =>
      checkTenantCredit(agentId, { controlPlaneUrl, internalSecret: requireControlPlaneSecret() }),
    // The words of a voice message, from the same control-plane and internal
    // bearer as the file-link requests. A failed transcription answers null and
    // leaves the turn to the upload path.
    transcribeVoice: (agentId, path) =>
      requestVoiceTranscript(agentId, path, {
        controlPlaneUrl,
        internalSecret: requireControlPlaneSecret(),
      }),
    // The organization's wall clock, and the pair's last turn when this
    // process has just started and remembers nobody. Wired on the same
    // condition as the gate above and for the same reason: without the
    // internal bearer there is nothing to authenticate with.
    //
    // The platform comes from the agent's own configuration rather than from
    // the message, because the control-plane stores a channel identity per
    // platform and matching on the id alone would collide the day two
    // platforms hand out the same string.
    turnContext: async (agentId, userId) => {
      const platform = config.agents.find((a) => a.id === agentId)?.channel;
      const ctx = await fetchTurnContext(
        agentId,
        { platform, platformUserId: userId },
        { controlPlaneUrl, internalSecret: requireControlPlaneSecret() },
      );
      return {
        clock: formatWallClock(Date.now(), ctx.timezone),
        lastTurnAt: ctx.lastTurnAt,
        instructionsChanged: ctx.instructionsChanged,
        notes: ctx.notes,
      };
    },
    // How the assistant's previous conversation ended, for a new one. Wired on
    // the same condition as the gate above.
    recentConversation: (agentId) =>
      fetchRecentConversation(agentId, { controlPlaneUrl, internalSecret: requireControlPlaneSecret() }),
    onSummaryWithheld: captureSummary,
    // What a session that replaces one too large to summarise starts from.
    // Wired on the same condition as the gate above.
    lastSummary: (agentId) =>
      fetchSessionSummary(agentId, { controlPlaneUrl, internalSecret: requireControlPlaneSecret() }),
    // Asked of the adapter at every turn rather than once, because a reload
    // replaces an agent's adapter in the map this reads.
    wholeAnswers: (agentId) => adapters.get(agentId)?.wholeAnswers,
    pendingMessages,
    // The turn's status line, on a channel that keeps one. Asked of the
    // adapter at every turn for the same reason as `wholeAnswers`.
    resolveStatusLine: (agentId, userId) => adapters.get(agentId)?.statusLine?.(userId),
    // The sentence for each step the status line names, from the catalogue
    // the control-plane holds. Without the bearer the call fails, and the
    // line says the bridge's plain sentence.
    toolStep: (agentId, step) =>
      fetchToolStep(agentId, step, { controlPlaneUrl, internalSecret: requireControlPlaneSecret() }),
    // A platform notice goes to the adapter as it is, past every filter of the
    // send target below: those clean what the model wrote, and the platform
    // wrote this. An adapter that draws no notice gets it spelled out through
    // the send target instead.
    resolveNoticeTarget: (agentId, userId) => {
      const adapter = adapters.get(agentId);
      if (!adapter) {
        throw new Error(`no chat adapter registered for agent "${agentId}"`);
      }
      const send = adapter.sendNotice?.bind(adapter);
      if (!send) return undefined;
      return async (notice) => {
        const result = await send(userId, notice);
        // A notice also meets the 50278 refusal, and marking it here is what
        // keeps the status honest when the notice was the first send to that
        // person after the bot lost the server they were in.
        if (!result.ok && isNoSharedServer(result.error)) markNoSharedServer(agentId, userId);
        return result;
      };
    },
    // A notice is closed by the adapter of the agent that posted it, from the
    // reference the control-plane kept.
    resolveNoticeCloser: (agentId) => {
      const adapter = adapters.get(agentId);
      if (!adapter) {
        throw new Error(`no chat adapter registered for agent "${agentId}"`);
      }
      return adapter.closeNotice?.bind(adapter);
    },
    resolveSendTarget: (agentId, userId) => {
      const adapter = adapters.get(agentId);
      if (!adapter) {
        throw new Error(`no chat adapter registered for agent "${agentId}"`);
      }
      const sendNow = sendThrough(adapter, agentId, userId);
      // A chunk the channel cannot carry is kept and sent once it can, behind
      // whatever is already kept for this person: a channel that refused its
      // bot, a client that reports itself down, an adapter replaced since this
      // turn began. A chunk the channel refuses while it can carry it is the
      // channel's answer to that message, and goes back to the send queue.
      return async (chunk: string): Promise<DeliveryResult> => {
        const text = await withApprovalLink(agentId, chunk);
        // A marked person is still attempted once for a new chunk: the bot
        // cannot see members without a privileged intent, so a send is the
        // only way to learn they joined a server the bot is in. On success the
        // refusal is over and what was kept goes after this message; on 50278
        // the chunk is kept too, with no retry and no failure marker into the
        // same refused DM.
        if (noSharedServerMarkAt(agentId, userId) !== undefined) {
          const result = await sendNow(text);
          if (result.ok) {
            clearNoSharedServer(agentId, userId);
            await deliverKept(agentId, userId);
            return result;
          }
          if (isNoSharedServer(result.error)) {
            markNoSharedServer(agentId, userId);
            return keepReply(agentId, userId, text);
          }
          if (!channelCanCarry(agentId, adapter)) return keepReply(agentId, userId, text);
          return result;
        }
        if (keptReplies.pending(agentId, userId)) await deliverKept(agentId, userId);
        if (keptReplies.has(agentId, userId) || !channelCanCarry(agentId, adapter)) {
          return keepReply(agentId, userId, text);
        }
        const result = await sendNow(text);
        // 50278 is final for this message: retrying it and posting the failure
        // marker would meet the same refusal, so the reply is kept and the
        // person is reported once instead.
        if (!result.ok && isNoSharedServer(result.error)) {
          markNoSharedServer(agentId, userId);
          return keepReply(agentId, userId, text);
        }
        if (!result.ok && !channelCanCarry(agentId, adapter)) return keepReply(agentId, userId, text);
        if (result.ok) clearNoSharedServer(agentId, userId);
        return result;
      };
    },
  });

  // The messages the previous bridge kept while it stopped are answered by
  // this one, an agent's as soon as its adapter is up, because the answer goes
  // out through it: at boot, on a reload, and when a retry brings it back. A
  // message for an agent that never comes up stays in the file, and one older
  // than the age limit by then is not answered: its person is told instead.
  const answerKept = (agentId: string): void => {
    void replayPending(
      pendingMessages,
      agentId,
      // Received when the person sent it, so that kept once more by a stop
      // that comes before it reaches the assistant, it keeps its place. It was
      // not written during a turn of this process, so it never joins one.
      (m) =>
        productionDispatcher.handleMessage(m.agentId, m.userId, m.text, Date.parse(m.receivedAt), {
          byPerson: false,
        }),
      () => productionDispatcher.isStopping(),
      (userId, expired) =>
        productionDispatcher.tellKeptMessagesExpired(
          agentId,
          userId,
          expired.map((m) => m.text),
        ),
    ).catch((err) => {
      logger.error({ err, agentId }, "answering the kept messages failed");
    });
  };

  // An agent's channel has come up: what was kept for its people while it was
  // down goes first, then the messages the previous bridge kept are answered,
  // whose replies queue behind it.
  const channelBack = (agentId: string): void => {
    deliverKeptFor(agentId);
    answerKept(agentId);
  };

  /**
   * Wire one adapter the bridge is about to hold, at boot and on every reload.
   * A fresh adapter is a fresh view of the platform, so the marks of the
   * adapter it replaces described a bot that is gone and are dropped. Its
   * reachability event — Discord's GUILD_CREATE, the bot arriving in a server —
   * means the person who shared no server with the bot can be DMed again:
   * every mark of this agent is cleared and the replies kept for those people
   * are sent.
   */
  const registerAdapter = (adapter: ChatAdapter): void => {
    clearNoSharedServerFor(adapter.agentId);
    adapter.onReachable?.(() => {
      clearNoSharedServerFor(adapter.agentId);
      channelBack(adapter.agentId);
    });
  };

  // Build the adapter table before the start loop below.
  for (const agent of config.agents) {
    const adapter = await createAdapter(agent, productionDispatcher);
    adapters.set(agent.id, adapter);
    registerAdapter(adapter);
  }

  // A channel can come back with no start to say so, a client reconnecting by
  // itself: while anything is kept, each agent is asked at this interval
  // whether its channel can carry it now. The variable is for tests.
  const keptPollEnv = Number(process.env.CERASE_ACP_KEPT_REPLY_POLL_MS?.trim() || "");
  const keptPoll = setInterval(
    () => {
      for (const agentId of keptReplies.agents()) deliverKeptFor(agentId);
    },
    Number.isFinite(keptPollEnv) && keptPollEnv > 0 ? keptPollEnv : KEPT_REPLY_POLL_MS,
  );
  keptPoll.unref();

  // agentIds whose most recent start() rejected.
  // Tracked so getAgentStatus reports them ready:false (not null) even for
  // adapters that expose no ready() signal of their own. Cleared on a
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
          channelBack(agentId);
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
      channelBack(agentId);
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
   * the boot loop and every config reload get both from this one function.
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
    // A refused DM is reported last: a refused credential and a missing
    // session mode are still the things a person must fix first, because no
    // message reaches the assistant while either holds. The first person
    // marked is named; the channel and every other person of the agent are
    // working, which is why this alone is not "the channel is down".
    const refusedPeople = noSharedServerMarks.get(id);
    const userId = refusedPeople?.keys().next().value;
    if (refusedPeople && userId !== undefined) {
      return {
        failure: {
          kind: "no_shared_server",
          user_id: userId,
          detail:
            "The bot shares no server with this person, so Discord refuses every DM to them. Add the bot to a server the person is in, using the link the console shows; the replies kept for them are sent once it is there.",
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
      // rather than "stato sconosciuto". An adapter with no readiness signal
      // of its own (Telegram, Slack, web) reports `null` (unknown); Discord
      // (client.isReady() and the reachability probe) and Workspace Chat
      // (route registered, listener bound) report a concrete boolean.
      ready: startFailures.has(id) ? false : adapter.ready ? adapter.ready() : null,
      // How long since the channel provider actually answered this adapter.
      // `ready` above already folds it in, so this is the reader's way of
      // telling the two down-states apart: a client that knows it dropped, and
      // a client that believes a dead socket is alive. Null on a channel that
      // measures nothing, which is every channel but Discord today.
      lastContactAgeMs: adapter.reachability ? adapter.reachability().ageMs : null,
      // Turns outstanding for this assistant right now. The control-plane asks
      // it before it replaces an AGENTS.md, because that write restarts the
      // slot.
      turnsInFlight: sessionManager.turnsInFlight(id),
    }));

  // The internal server: POST /internal/inject, which the control-plane
  // calls with scheduled messages, console messages and platform notices
  // (shared-secret), the read-only GET /internal/status liveness probe and
  // GET /healthz. Started when the internal secret is configured.
  let internalServer: InternalServer | undefined;
  if (acpInjectSecret) {
    internalServer = await startInternalServer({
      dispatcher: productionDispatcher,
      internalSecret: acpInjectSecret,
      port: Number(process.env.CERASE_ACP_INTERNAL_PORT ?? "7476"),
      getAgentStatus,
      getSessionLimits: () => sessionManager.sessionLimits(),
      // Gate inject on the agent's allowlist (unknown agent → reject).
      isAllowed: (agentId, userId) => {
        try {
          return isAllowed(config, agentId, userId);
        } catch {
          return false;
        }
      },
      reportOutcome: async (ref, outcome) => {
        const secret = controlPlaneSecret();
        if (!secret) {
          logger.warn({ ref }, "the inject turn's outcome was not reported: agents.yaml carries no internal_bearer");
          return;
        }
        const posted = await postInjectOutcome(ref, outcome, { controlPlaneUrl, internalSecret: secret });
        if (!posted) {
          logger.warn({ ref }, "the inject turn's outcome could not be reported to the control-plane");
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
  // adapters all stay up. This holds in both modes.
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
    clearInterval(keptPoll);
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

  // Watch agents.yaml for live updates.
  // Snapshot the current config so the next reload can compute a diff
  // against a stable reference (the sessionManager mutates the shared
  // `config` object in place once we apply each diff).
  let currentSnapshot: BridgeConfig = cloneConfig(config);
  let reloader: ConfigReloader | undefined;
  // A refused credential is fixed where agents.yaml cannot see it, in the
  // provider's portal, so the console's way back is a regeneration that leaves
  // the file as it was. A reload that changes no agent therefore starts again
  // every agent held as refused, through startAdapter, which reports the
  // outcome as at boot: a refusal that still holds is recorded again with its
  // sentence, a start that succeeds clears it. Every other agent is left
  // alone. The supervisor's own record of the refusal is dropped first, so a
  // start that now fails for a reason that can pass is retried as usual.
  const startRefusedAgain = async (): Promise<void> => {
    const refused = Array.from(credentialRejections.keys()).filter((id) => adapters.has(id));
    if (refused.length === 0) return;
    logger.info(
      { agentIds: refused },
      "auto-reload: no config change; starting again the agents whose credential was refused",
    );
    for (const agentId of refused) {
      const adapter = adapters.get(agentId);
      if (!adapter) continue;
      supervisor?.cancel(agentId);
      await startAdapter(adapter);
    }
  };
  const applyReload = async (nextConfig: BridgeConfig): Promise<void> => {
    // A bridge that is stopping starts no adapter it would stop a moment later.
    if (productionDispatcher.isStopping()) return;
    // Before the diff, which compares agents only: a change to the session
    // limits or to the organisation's language alone changes no agent, and the
    // early return below would drop it. The dispatcher reads the language off
    // this object for every notice it writes. The file-size limit needs
    // nothing here: loadConfig sets it on every load.
    sessionManager.applySession(nextConfig.session);
    config.locale = nextConfig.locale;
    config.internal_bearer = nextConfig.internal_bearer;
    const diff = diffConfigs(currentSnapshot, nextConfig);
    if (diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0) {
      await startRefusedAgain();
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
    try {
      await applyConfigDiff(diff, {
        next: nextConfig,
        sessionManager,
        adapters,
        createAdapter,
        dispatcher: productionDispatcher,
        startAdapter,
        onAdapterCreated: registerAdapter,
        forgetAgent: (agentId) => {
          supervisor?.cancel(agentId);
          clearNoSharedServerFor(agentId);
          const dropped = keptReplies.forget(agentId);
          if (dropped > 0)
            logger.warn({ agentId, dropped }, "auto-reload: an agent removed with replies still kept — dropped");
        },
      });
      currentSnapshot = cloneConfig(nextConfig);
    } catch (err) {
      logger.error({ err }, "auto-reload: applyConfigDiff threw — snapshot NOT advanced");
    }
  };
  // Each reload is applied once the one before it has been, and is diffed
  // against the configuration that one left. Applying a reload waits on adapter
  // stops and starts, so a file written again in the meantime would otherwise
  // be diffed against the configuration before both, and its adapters started
  // while the previous ones were still starting.
  let reloading: Promise<void> = Promise.resolve();
  if (opts.configPath) {
    reloader = new ConfigReloader(opts.configPath, (nextConfig) => {
      reloading = reloading.then(() => applyReload(nextConfig));
    });
    reloader.start();
    logger.info({ configPath: opts.configPath }, "auto-reload: ConfigReloader started");
  }

  // How long the stop waits for the turns in flight. The variable is for
  // tests, which cannot wait three minutes.
  const drainEnv = process.env.CERASE_ACP_STOP_DRAIN_MS?.trim();
  const stopDrainMs =
    drainEnv && Number.isFinite(Number(drainEnv)) && Number(drainEnv) >= 0 ? Number(drainEnv) : STOP_DRAIN_MS;

  // Order: stop reloader + self-heal supervisor → let the turns in flight
  // end → let a reload being applied finish → stop the adapters → close the
  // test and internal servers → kill ACP children. Reverse of startup so dependents go first;
  // stopping the supervisor first prevents a retry racing the teardown, and
  // waiting for the reload keeps it from starting an adapter after the
  // adapters were stopped. The adapters and the internal server stay up while
  // the turns end, because the answers go out through them and a message
  // arriving meanwhile has to be received to be kept.
  const stop = async (): Promise<void> => {
    if (reloader) reloader.stop();
    supervisor?.stop();
    clearInterval(keptPoll);
    await productionDispatcher.stop({
      limitMs: stopDrainMs,
      noticeMs: STOP_NOTICE_MS,
      endSessions: () => sessionManager.shutdown(),
    });
    await reloading;
    await Promise.allSettled(Array.from(adapters.values()).map((a) => a.stop()));
    if (testServer) await testServer.close();
    if (internalServer) await internalServer.close();
    await sessionManager.shutdown();
  };
  // A second signal while the first stop is still waiting gets the same stop,
  // not a second one tearing down under it.
  let stopping: Promise<void> | undefined;

  return {
    testInjectionUrl: testServer?.url(),
    internalUrl: internalServer ? `http://127.0.0.1:${internalServer.port()}` : undefined,
    shutdown() {
      stopping ??= stop();
      return stopping;
    },
  };
}

/**
 * Copy of the agents and session block of a BridgeConfig, so the
 * auto-reload's "previous snapshot" doesn't share array references with the
 * shared config (which SessionManager mutates in place via updateAllowlist /
 * addAgent / removeAgent). `locale` and `max_file_mb` are left out:
 * diffConfigs compares agents only.
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

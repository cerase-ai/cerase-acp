# cerase-acp — completed work (closeout record)

This is the single record of everything shipped for `cerase-acp` during the
PoC phase. `cerase-acp` is the in-house Discord-to-ACP DM bridge — the one
TypeScript artefact in the Cerase stack — and its `v0.1` line was the PoC
slice of the umbrella **M4** milestone (`cerase/devplan/poc.md` §M4): DM-only
Discord ingestion, a long-lived ACP v1 stdio session per `(user, agent)`,
`[turn_meta]` injection, crash-recovery, allowlist enforcement, and the
`BRIDGE_E2E_TEST` injection endpoint that drives end-to-end tests from the
cerase-core repo.

Every milestone below is **code-complete with green suites** (vitest, tsc,
biome). The only work that ever remained on the most recent milestones is
operator-gated **LIVE verification** — that checklist lives in
**[`v0.1.md`](v0.1.md)**, the active remainder file. Full prose detail for
each milestone (design, scope, task lists, exit gates, disposability stances)
is retained in git history.

---

## cerase-acp v0.1 — PoC closeout (May–June 2026)

| Milestone | When | What |
|---|---|---|
| M1 | 05-24 | Repo init + project layout (package.json/tsconfig/vitest pins, strict TS, src scaffold) |
| M2 | 05-24 | Config + allowlist (`agents.yaml` zod schema + `${env:VAR}` substitution + per-agent `user_id` allowlist) |
| M3 | 05-24 | ACP session manager + prompt queue (long-lived per-`(user,agent)` session, FIFO queue, fake-acp-child fixture) |
| M4 | 05-24 | Turn-meta + stream buffer + send queue (gap/lang prefix, chunk batching, 2000-char Discord chunking + rate-limited send) |
| M5 | 05-24 | Discord adapter + `index.ts` + `BRIDGE_E2E_TEST` injection endpoint (Discord-agnostic dispatcher pipeline) |
| M6 | 05-24 | Dockerfile + image build (multi-stage node:20 → slim, tini PID 1, docker.io for sibling-container `docker exec`) |
| M7 | 05-24 | Standalone CLI + bash wrapper (`prompt` / `repl` / `inject` against fake-child or real opencode acp) |
| M8 | 05-24 | Bridge resilience under failing Discord logins (test-mode); `runBridge()` extraction + dual-dispatcher fix |
| M9 | 05-24 | Agent `cwd` from agents.yaml (stop leaking host/bridge cwd to the agent) |
| M10 | 05-24 | Loggers write to stderr not stdout (`./cli.sh prompt \| jq` works; central `logger.ts`) |
| M11 | 05-24 | CLI fallback: stream `agent_thought_chunk` when zero `agent_message_chunk` arrive |
| M12 | 05-24 | Drain post-prompt stream (mitigate opencode upstream #17505 / #25421 late-chunk race) |
| M13 | 05-24 | In-process TS REPL (one persistent ACP child — mirrors the Discord daemon lifecycle) |
| M14 | 05-24 | Quiet the permission-denied log at default level (warn → info) |
| M15 | 05-24 | Drain budget bump (8s ceiling) + per-turn `[turn_telemetry]` timing instrumentation |
| M16 | 05-24 | Shadow-channel REST reconciliation (`opencode-rest.ts` + `reconciler.ts`; recover the canonical reply from the audit log) |
| M17 | 05-24 | Upstream engagement on opencode #17505 (high-signal issue comment + patch sketch; full PR deferred) |
| M18 | 05-24 | Discord "is typing…" indicator during prompt processing (`typing-keepalive.ts` + 👀 react) |
| M19 | 06-07 | Auto-approve ACP permission requests (`permission-policy.ts`; DM-only agents trust the container boundary) |
| M21 | 06-19 | README onboarding & Discord setup guide (quick local setup, channels table, Discord portal walkthrough, troubleshooting) |
| M22 | 06-24 | Production bridge resilient to a single adapter start failure (per-adapter try/catch; total-failure threshold; truthful `ready:false`) |
| M23 | 06-24 | Auto-heal a failed adapter (`adapter-supervisor.ts` — capped jittered exponential-backoff retry, per-agent isolated) |
| M24 | 06-24 | Truthful container healthcheck — unauthenticated `GET /healthz` on the internal server (counts only, secret gate untouched) |

(There is no M20 — the numbering skips from M19 to M21.)

Full prose detail for every milestone above is retained in git history.

---

## Out of scope for v0.1 (deferred)

Carried forward in [`v0.1.md`](v0.1.md):

- **Slack / Telegram adapters** — Tier-0 only, by customer request.
- **Multi-bot per agent** — one bot per template is the PoC contract.
- **Persistent session-store across container redeploys** — v0.1 relies on
  mem0 + the persisted workspace inside the agent container to recover
  continuity on the next user turn; a dedicated session-store is a v0.2 concern.
- **Skill command pinning, slash commands, button-based permission approval**
  — explicit UX-incompatibility per cerase M2 rules.
- **Doctor checks** — structured pino logs cover the PoC observability need.

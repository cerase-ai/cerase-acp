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
operator-gated **LIVE verification** — that checklist is closed and kept
below, moved from **[`v0.1.md`](v0.1.md)** on 2026-09-28. Full prose detail for
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
| `M-THE-LIVENESS-PROBE-PASSES-ON-ANY-REPLY-1` | 08-22 | The session mode is a per-agent config value instead of a constant. opencode exposes its primary agents as ACP session modes and `opencode acp` has no flag to pick one, so the mode IS the agent selector — and it was hardcoded `"cerase"`, which meant every caller got the customer's own assistant. The health probe in `cerase-core` asks for one word and the customer's assistant reasonably answers a paragraph, so nothing could be asserted about the reply. `agent.mode` defaults to `cerase`, so a config written before the field loads unchanged and asks for what it always asked for; a mode the slot does not define is refused per agent with the modes it does offer, exactly as an absent `cerase` already was; and a changed mode respawns, because the mode is chosen once at the handshake and a live session would otherwise pick it up whenever it happened to end. Driven by `cerase-core/devplan/poc.md` |
| `M-GOOGLE-CHAT-SHOWS-THE-ASSISTANT-IS-WRITING-1` | 09-29 | Google Chat shows that a message was received and an answer is coming. Chat gives an app neither a read receipt nor a typing indicator (a reaction needs user authentication, and the API has no typing call), so on an accepted message the app posts one line in the conversation's language (*Sto scrivendo…*) where the reply will go, and deletes it with `spaces.messages.delete` under the same app key once the first part of the reply is posted, or when the turn ends with nothing posted or throws. The reply is a new message, so the phone's notification shows the reply. Each turn owns its own line: two messages in quick succession each keep theirs until their own reply, and a scheduled message removes neither. A line Google refuses to post or delete, or answers slowly, is logged and never delays the reply. The live check on a box (seen within a second, only the answer stays) is still to be made. Code `91b9c0a` |
| `M-GOOGLE-CHAT-PLACEHOLDER-TURNS-INTO-AN-ELLIPSIS-1` | 09-29 | The *Sto scrivendo…* line is edited instead of deleted. At every moment it used to be deleted (the first part of the reply posted, or a turn that ends with nothing to say, fails, times out or throws) its text is rewritten to a single *…* with `spaces.messages.patch` and `updateMask=text` under the same app key, so it stays above the reply, which is still a new message and so still rings the phone. `deleteMessage` is gone and nothing is deleted. One edit per placeholder, never awaited by the reply; each turn edits only its own line and a scheduled message edits none; a refused or slow edit is logged. A placeholder Google posts after the reply ends as *…* below the reply. The live check on a box is still to be made. Code `22b4bbf` |
| `M-GOOGLE-CHAT-PLACEHOLDER-IS-A-SPEECH-BALLOON-1` | 09-30 | The placeholder posted when a Google Chat message is accepted is a single speech balloon, 💬 (U+1F4AC), the same in every language, instead of the localised *Sto scrivendo…* line, which the operator found poor. He chose a symbol over dots that move while the assistant works: each move would be an edit, and Google allows one write per second per space, shared by posts, edits and deletes, so moving dots would spend that quota on the long turns, where the answer's own posts need it. Everything else is as the ellipsis milestone shipped it: the line is edited once to *…* at every end path, the answer is a new message that is never delayed, and each turn touches only its own line, so a 💬 still standing means that message is still being worked on. The four translations are removed and `Dispatcher.noticeLang` is private again. The live check on a box is still to be made. Code `b67e000` |
| `M-GOOGLE-CHAT-POSTS-AT-GOOGLES-PACE-1` | 09-30 | An answer on Google Chat stays inside Google's write limit of one a second per space, shared by posts, edits and deletes. The send queue's 100 ms, Discord's pace, had every part after the first and the placeholder's edit refused with 429, retried once at once and lost. `WorkspaceChatApi` now gives every post and edit a turn in its space: in the order asked, a second after the previous request left, with spaces independent of each other, so a slow answer from Google holds nothing behind it for longer. The placeholder's edit takes the turn after the answer's first part, which it never delays. A 429 is sent again after its Retry-After, in seconds or as a date, or after 1, 2, 4 and 8 s, and the space waits with it; the fifth refusal, or a Retry-After over a minute, is final and logged as an error. Discord keeps its 100 ms. Tested on fake timers against a Google that refuses a second write within a second; eleven of the thirteen tests fail on the previous code. Code `2f78686` |
| `M-THE-TEST-FILES-ARE-TYPE-CHECKED-1` | 09-30 | A type error in a test fails the suite as one in the code fails the build. `tsconfig.json` leaves the tests out, because the image carries none, and vitest runs a test without checking its types; a one-off check found 66 errors. `tsconfig.test.json` applies the build's settings to everything under `src`, tests and shared fakes included, and `src/typecheck.test.ts` runs it inside the suite, which CI runs, asserting no error and that every test file is read; `npm run typecheck` runs it alone and `npm run lint` uses it. The 66 were fixed in the fixtures and fakes: agent fixtures carry the channel, cwd and mode the parser defaults, stub turns resolve with a `PromptResult`, writer fakes are `FileWriter`, fields an extractor does not read are typed onto its input, and index reads after a length assertion use `!`. Proven with a string assigned to a number in a test: the build and that test passed, `npm test` failed naming the line. Code `fd8c768` |
| `M-UNDICI-HIGH-CVE-BLOCKED-THE-PUBLISH-1` | 09-30 | The publish of `b8982d5` was refused by Trivy for CVE-2026-19534 (high) in `undici` 6.28.0, pulled in by discord.js. Raised to 6.29.0, the same change as Dependabot PR #39, which is closed; the next publish passed the scan (`sha-562c6a9`). | `42b7c94` |
| `M-GOOGLE-CHAT-PLACEHOLDER-IS-SEEN-LIVE-1` | 10-01 | The 💬 → «…» placeholder seen on a real Google Chat conversation: the operator wrote to Guido on `lt-seats-2` (release `2026.09.30-5`, `cerase-acp:sha-c76e02a`) and confirmed it on 2026-10-01. The bridge logs a placeholder post or edit only when it fails, and no warning or error was logged in the 24 hours around that turn; whether the phone rang on the answer rests on the operator's word. | `c76e02a` |

(There is no M20 — the numbering skips from M19 to M21.)

Full prose detail for every milestone above is retained in git history.

---

## Operator-gated LIVE verification — moved from `v0.1.md`, 2026-09-28

- [x] **M18 — Discord "is typing…" indicator. Observed by the operator 2026-08-21, and it is three of four.**
  A DM to an assistant showed the indicator promptly and it persisted through the turn, so the appearance
  and the 7-second refresh are confirmed on a real client — the half no suite can answer.
  ⚠️ **The fourth point did not hold: it kept running for a few moments AFTER the reply had landed.**
  The operator's words: *"ha quasi funzionato… in realtà ha aspettato qualche istante dopo che è arrivata
  la risposta."* Clearing on reply is asserted in the suite, so the assertion and the client disagree —
  which means the suite is asserting the call and not the effect, or the clear is issued after the send
  rather than before it. Carried on as its own box below rather than left inside a ticked one.

- [x] **M18b — the typing indicator outlives the reply.** Discord keeps the indicator up for ~10 s unless
  it is cancelled, so "stop refreshing" and "clear" are not the same act and the suite may only be
  covering the first. Find which of the two the bridge does, make it clear on the send rather than after
  it, and assert the ORDER against the message send — an assertion that the clear eventually happens is
  satisfied by the timeout that made this visible.

  **The bridge did the first.** `stopTyping()` was `clearInterval`, called from the MessageCreate
  `finally` — after `handleMessage` had returned, and therefore after the send. Discord has no call that
  takes the indicator down, so the clear is the message itself and a refresh reaching Discord afterwards
  puts it back up for another ~10 s.

  **Decision.** The keepalive is ended by the turn's FIRST delivery: `TypingSessions.end(userId)` is
  awaited immediately before `channel.send`, so a refresh already on the wire lands before the message
  rather than after it, and it is not raised again for the rest of that turn — the send path cannot know
  whether another chunk follows, and a refresh issued after what turns out to be the last one is the same
  ghost by another route. The `finally` stays as the leak guard for a turn that delivers nothing. The
  oversize-attachment notice moved ahead of the keepalive for the same reason: it is a message, and
  raising the indicator in front of one we are about to send spends it immediately.

  **Asserted as an order, not as an eventuality.** `typing-keepalive.test.ts` drives a fake DM channel
  whose `sendTyping` and `send` write to one log: no refresh appears after the send even 60 s later, and a
  refresh held on the wire is shown to land BEFORE the message — the case an unawaited stop gets wrong.
  Both fail when the fix is removed. The adapter's use of that order is pinned by index in
  `discord-adapter.test.ts`.

- [x] **M21 — README onboarding & Discord setup guide.** **Audited 2026-08-10 by extracting from both
  sides and comparing**, rather than by reading it through:

  - **Commands and flags: correct.** Every `npm run` script the README names exists
    (`build dev test test:watch lint lint:biome format start`), and every flag it shows is real.
    `--remote` looked wrong at first — it is not in `src/cli.ts` — and it is right: it belongs to
    `scripts/cerase-acp-cli`, the shell wrapper the README is invoking on that line. Measured before
    reporting it, which is why it is not in the list below.
  - **Environment variables: six were missing, now documented.** The code reads 13; the README named 7.
    `CERASE_CONTROL_PLANE_URL` · `CERASE_INTERNAL_SECRET` · `CERASE_AGENT_WORKSPACE_ROOT` ·
    `CERASE_MAX_ATTACHMENT_MB` · `WORKSPACE_CHAT_PORT` · `OPENCODE_SERVER_PASSWORD` were read with
    defaults compiled in and explained nowhere. Added with their real defaults, read out of the source
    lines that use them.
  - ⚠️ **The one worth its own line: `CERASE_INTERNAL_SECRET` vs `CERASE_ACP_INTERNAL_SECRET`.** One is
    the bearer the bridge PRESENTS to the control-plane, the other is the bearer it DEMANDS. Two
    directions, two secrets, names one token apart — and only the second was documented. The table now
    says which is which.
  - `BRIDGE_E2E_TEST` is named as what it is: not an operational knob, and the daemon says *"never enable
    in production"* when it is set.

- [x] **M22 — Production bridge resilient to a single adapter start failure.**
  **Verified live on guidance 2026-08-10.** The bridge has been up since 2026-08-04 — six days —
  with `RestartCount=0`, so nothing is crash-looping. `/internal/status` answers with all three
  adapters `attached:true`. And the half that had never been exercised: a **real inject** to the web
  Manutentore returned **HTTP 202**, `inject.succeeded` went 0 → 1 with `failed:0`, and the assistant
  replied — *"Ricevuto, Manutentore. Verifica M22 del 10 agosto … sono operativo."*

  ⚠️ **The scenario in the original box no longer exists, and that is why it is worth writing down.** It
  said *"with agent-1's Discord token still invalid"*; agent-1 is now a **web** channel, so it reports
  `ready:null` — web adapters have no readiness — and the two Discord agents are both `ready:true`. There
  is no failed adapter on the box to observe. The property itself is asserted where it can be:
  `adapter-supervisor.test.ts` → *"isolates retries per adapter — one agent's failure does not touch
  another"*, plus retry-after-backoff, exponential backoff, and cap-with-jitter.

  ⚠️ **`/healthz` counts `ready`, and a web adapter is never `ready`.** It answered
  `{"status":"ok","adapters":3,"ready":2}` on a completely healthy bridge, which reads as "one is down".
  Nothing consumes that number today; it is a trap for whoever wires an alert to it first.

- [x] **M23 — Auto-heal a failed adapter. Proven live on the local stack 2026-08-21.**
  ⚠️ **Its gate was false.** The box said it needed *"the network to Discord cut and restored on a
  production bridge two colleagues are using"* — nobody is using these machines, and it never needed
  production: the local stack runs the same three adapters, two Discord and one web, which is the shape
  guidance has. It was a laptop measurement all along.

  **The measurement, and the first cut proved nothing.** Disconnecting `cerase_default` left the bridge
  reaching Discord anyway — the container is on **two** networks and `cerase_slots` is not `internal`, so
  egress survived. Six minutes of that were worthless until `fetch` to Discord from inside the container
  was checked and answered 200. With both networks removed Discord was genuinely unreachable
  (`TypeError`), and after five minutes the networks were restored.

  **It healed, and the proof is not a flag.** All sockets die with the interfaces, so a connection that is
  ESTABLISHED afterwards can only have been rebuilt: `/proc/net/tcp` in the container showed exactly one
  outbound TLS connection, to `162.159.135.234:443`, which is one of `gateway.discord.gg`'s A records.
  `RestartCount` was 0 before and after, so nothing restarted it. One connection for two Discord adapters
  is the right number — `agent-10`'s token is terminal.

  The retry-on-start path is separately confirmed on the same bridge: `agent-10` reports
  `credential_rejected / TokenInvalid / bot_token` through `/internal/status`, naming the credential and
  never its value, instead of the endless retry the previous image was running at attempt 26.

- [x] **M23b — the bridge reported a healthy Discord adapter for five minutes while it had no network.**
  Through the whole outage `/healthz` answered `ready:1` and `/internal/status` showed `agent-1`
  `attached:true, ready:true`, and not one line was logged. The adapter recovered, so nothing was broken —
  but an alert wired to `ready` would not have fired, and an operator reading either surface during the
  outage would have been told the bridge was fine. `ready` is the client's cached state and not a probe.
  Either it reflects reachability, or the surfaces stop presenting it as health. Same family as the
  `readyOf` trap fixed above: what these endpoints mean has to survive somebody wiring an alert to them.

  **Decision: the first branch — `ready` now means reachable.** Removing it from the surfaces would leave
  the operator with less than M22 gave them, and `readyOf` set the shape: fix the number the alert is
  wired to rather than add a field beside it that nobody reads. So a Discord adapter reports ready only
  when discord.js says its socket is live AND Discord has answered inside the tolerance. The measurement
  is `ReachabilityMonitor`: an unauthenticated `GET /gateway` every 60 s (`CERASE_ACP_REACHABILITY_INTERVAL_MS`),
  plus every message the adapter sends or receives, and `ready` goes false once nothing has answered for
  180 s (`CERASE_ACP_REACHABILITY_STALE_MS` — three missed probes, so one blip cannot flip it). The
  measured outage would have been reported with two minutes still to run.

  **Two things beside it, both from the same measurement.** The probe is unauthenticated on purpose: a
  refused token is already reported as `credential_rejected` naming the value to fix, and letting it also
  read as an outage would put one failure under two names. And `lastContactAgeMs` is published on
  `/internal/status`, because "the client knows it dropped" and "the client believes a dead socket is
  alive" need different answers from an operator — the second is the network's problem, not the library's.
  The transition is logged in both directions, which is the other half of the defect: the outage produced
  no line at all.

  **Tests.** `reachability.test.ts` drives a provider that answers, refuses, or goes silent without ever
  answering — the shape of the measured outage — and asserts the flip, the single announcement of each
  transition, that a probe hanging for ever counts as silence, and that real traffic keeps a busy adapter
  fresh. `bridge.test.ts` holds the client flag `true` and shows `/internal/status` going `ready:false`
  with the age published and `/healthz` going 503, plus the non-vacuity case: an adapter that measures
  nothing keeps the older meaning and a null age.

- [x] **M24 — Truthful container healthcheck (`/healthz`).** **Measured on guidance 2026-08-10:**
  `docker inspect cerase-acp` → `healthy`, `FailingStreak=0`, `RestartCount=0`, and the test it runs is
  `node -e "fetch('http://localhost:'+PORT+'/healthz').then(r=>process.exit(r.ok?0:1))"` — it tracks the
  internal server actually answering, not the process existing. The cerase-core half
  (`M-ACP-HEALTHCHECK-1` compose `test:` rewire) is deployed: that command IS what the running container
  carries.

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

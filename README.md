# cerase-acp

The chat bridge of the Cerase platform. It connects each Cerase assistant to
direct messages on Discord, Telegram, Slack or Google Workspace Chat, and runs
every conversation as an [Agent Client Protocol](https://agentclientprotocol.com/)
session with the assistant's runtime, `opencode acp`, inside that assistant's
slot container. A `web` channel serves assistants that are reached only from the
Cerase console.

It is a Node.js/TypeScript service. The other Cerase components it works with:

- **the control-plane** (`cerase-core`) writes the bridge's `agents.yaml` from the
  console's settings, sends it scheduled and console messages through
  `/internal/inject`, and reads `/internal/status`;
- **the agent slots** (`cerase-agent-N` containers, also `cerase-core`) run
  `opencode acp`; the bridge reaches them with `docker exec`;
- **the control-plane's internal API** answers the bridge's questions about
  credits, the organisation's clock, pending approvals and rolling summaries.

## Where it runs

| | |
|---|---|
| Image | `ghcr.io/cerase-ai/cerase-acp`, built from this repo's `Dockerfile` (Node 22, `tini` as PID 1, the Docker CLI) |
| Container | `cerase-acp`, one per Cerase appliance, defined in `cerase-core/docker-compose.yml` |
| User | `node` (uid 1000, gid 1000) |
| Config | `/etc/cerase-acp/agents.yaml`, read-only. On an appliance the control-plane renders it into a mounted directory and the bridge reloads it on every change |
| State | `/var/lib/cerase-acp/state` (`CERASE_ACP_STATE_DIR`), a named volume on an appliance |
| Docker | the bridge runs `docker exec` and `docker inspect` against the slots, so it needs a Docker API: the socket, or `DOCKER_HOST` pointing at a proxy (the appliance uses a scoped proxy) |

Ports it listens on:

| Port | Listener | When |
|---|---|---|
| 7475 (`WORKSPACE_CHAT_PORT`) | Workspace Chat webhook, `POST /chat/event` | while at least one `workspace_chat` agent is registered |
| 7476 (`CERASE_ACP_INTERNAL_PORT`) | `/internal/inject`, `/internal/status`, `/healthz` | when `CERASE_ACP_INTERNAL_SECRET` is set |
| 7474, on 127.0.0.1 | test injection, `/_test/inject` and `/_test/last-reply` | only when `BRIDGE_E2E_TEST=1`; never in production |

```
 Discord · Telegram · Slack        Google Chat ──► :7475 /chat/event
            │                           │
            ▼                           ▼
       one channel adapter per agent ◄──┘
            │
            ▼
       Dispatcher ─ allowlist · credit check · turn_meta · restart hold · stop drain
            │
            ▼
       SessionManager ─ one `opencode acp` child per (agent, user)
            │             on an appliance: docker exec -i cerase-<agent id> opencode acp
            ▼
       stream buffer → egress filters → send queue → channel adapter → person

 control-plane ──► :7476  /internal/inject · /internal/status · /healthz
 bridge ────────► control-plane /api/internal/*  (credits, turn context, approval link, summaries)
```

## What it does

### Channels

Each agent in `agents.yaml` names one channel and carries that channel's
credentials. Every chat channel accepts direct messages only.

| Channel | Transport | What the person sees while the assistant works | Files the person sends | Files the assistant sends |
|---|---|---|---|---|
| `discord` (default) | `discord.js`, one bot per agent; messages in servers are ignored | a 👀 reaction on their message, and the typing indicator (refreshed every 7 s, ended by the first reply) | yes, up to 25 MB | yes |
| `telegram` | `telegraf`, long polling; private chats only | the typing action (refreshed every 4 s) | documents, photos, voice, audio and video, up to 20 MB | no: the person is told the channel cannot carry the file |
| `slack` | `@slack/bolt` in Socket Mode; `im` messages only | nothing | file shares, up to 1 GB | no, as above |
| `workspace_chat` | Google Chat app per agent; webhook in, Chat REST API out | a 💬 message, rewritten to … once the answer is posted | yes | no, as above |
| `web` | none: replies are discarded, and the console reads the conversation from opencode | — | — | — |

Every per-channel ceiling above is further capped by the console's file-size
limit (see `max_file_mb`). A file over the limit is refused from the size the
channel reports, before it is downloaded, and the person is told the size, the
limit and what to send instead.

Replies on Discord, Telegram and Slack are sent while the assistant writes, in
groups of sentences, cut at 2,000 characters with ` ⏎` ending every part but the
last. Workspace Chat receives each answer as one message (see below).

### Who may talk to an assistant

A message from a user not listed in the agent's `allowed_users` gets a short
refusal in the language it was written in, and reaches no assistant. The same
allowlist gates `/internal/inject`.

### Sessions

- **One ACP child per (agent, user).** It is spawned with the agent's
  `spawn.command` and `spawn.args` on the first message and reused for the next
  ones; a pair's messages are sent one at a time, in order. A child idle for
  `session.idle_timeout_minutes` is stopped. At `session.max_concurrent`
  children, the least recently used is stopped to make room.
- **A session the bridge ends is sent nothing more.** When the bridge ends a
  session (idle, eviction, a reload, the turn watchdog, a session too large to
  summarise), the turn running is left to end and the messages queued behind it
  are not sent to the child going away: each is sent, in its place, to the
  session that replaces it, or kept for the next bridge while the bridge stops.
- **The session mode.** Each session is put in the opencode mode named by the
  agent's `mode` (default `cerase`, the Cerase profile the control-plane writes
  into the slot). When the slot does not offer that mode, the agent's sessions
  are refused and `/internal/status` reports the failure
  `session_mode_missing` with the modes the slot does offer.
- **Conversations survive restarts.** The session id of each pair is kept in
  memory and in `resumable-sessions.json` in the state directory (written
  through a temporary file and a rename, at most 500 pairs, least recently used
  dropped first). The next child for the pair resumes it with `session/load`
  when opencode advertises that capability. A session that cannot be loaded is
  forgotten and a new one started. When the agent has a `model` and the resumed
  session reports a different one, the bridge sets it back before the first
  prompt, and starts a new session if opencode refuses.
- **Permission requests** from opencode are answered automatically:
  `allow_always` when offered, then `allow_once`, otherwise cancelled. The slot
  container is the security boundary.
- **Turn watchdog.** A turn whose ACP stream says nothing for
  `session.turn_silence_seconds` (default 180) is ended and its child killed,
  unless a tool call it opened is still running: a sub-agent started with the
  `task` tool sends this session nothing until it returns, so while a tool call
  is open only the ceiling applies. A turn still running after
  `session.turn_ceiling_minutes` (default 45) is ended and the person asked to
  split the request. The next message spawns a new child.
- **Text the ACP stream dropped.** After each turn the bridge reads the
  finished assistant message from opencode's REST API inside the slot
  (`docker exec` running `curl` against `127.0.0.1:3284`, with the slot's own
  server password) and sends whatever the stream did not deliver.
- **A session too large to summarise.** When opencode ends a turn with JSON-RPC
  error -32603, `data.errorName` `ContextOverflowError` and a message saying the
  session is too large to compact, every later turn of that session would fail
  the same way. The bridge drops the session and its stored id, tells the person
  in their language that the conversation started over, and sends their message
  once more to a new session, preceded by a block for the assistant alone that
  opens `[session_result: started over]` and carries the assistant's last
  rolling summary from the control-plane (or says there is none). A failure of
  that second try is reported as a failed turn. Code: `isCompactionOverflow` and
  `SessionOutgrownError` in `src/session-manager.ts`, `Dispatcher.startOver`.

### Each turn

1. **Credit check.** Before anything is spawned, the bridge asks the
   control-plane whether the organisation has credits left
   (`POST /api/internal/credit-check/{agent}`). A 402 answer gets the person a
   message saying the credits are exhausted, and no turn runs. A check that
   fails lets the turn through. A turn that fails on the credit gate's error
   gets the same message.
2. **`turn_meta` block.** The prompt opens with
   `[turn_meta: gap=…, lang=…, now=…]`: the time since the pair's previous
   message, the detected language
   (Italian, English, Spanish or French), and the organisation's wall clock from
   `GET /api/internal/turn-context/{agent}`, which also supplies the previous
   message's time after a bridge restart. The rules the assistant reads it by
   are in the baseline prompt, `cerase-core/control-plane/config/defaults/agents-baseline.md`.
3. **Platform notes.** Text injected through `/internal/inject` that opens with
   `[platform_note sig=` and arrives while a turn of that conversation is
   running waits for it; the notes that arrived meanwhile reach the assistant
   together as one prompt.
4. **An answer written as a tool call.** An answer that ends in a tool call
   spelled out as text (`<tool_calls>`, `<function_calls>`, `<tool_call>`, a bare
   `<invoke name=…>`, or DeepSeek's DSML markers) is held back from that block
   on; the sentence before it is sent. The assistant gets one more try on the
   same session, with a prompt that opens `[reply_result: not sent]` and says
   nothing ran. When the second answer ends the same way, the person is told the
   answer did not come out and to ask again, and the turn reports a failure. A
   block inside a code fence, or followed by prose, is a quotation and is sent
   unchanged. Rule and recorded shapes: `src/tool-call-markup.ts`.
5. **A turn that says nothing.** A turn that ends with no text and no tool call
   is asked again at once on the same session, up to three times, with a prompt
   that opens `[reply_result: empty]` and tells the assistant to answer the
   person. Nothing is sent between tries, so the typing indicator stays on. A
   fourth empty answer tells the person it is taking longer than expected. A
   failed turn is never asked again: provider errors keep the runtime's own
   backoff. Rule: `src/empty-turn.ts`.
6. **Notices.** A failed turn, a turn that ran a tool and wrote nothing, a
   fourth empty answer, and a chunk the channel refused twice each get a short
   message in the person's language: the language of their message, else the
   last one they wrote in, else the organisation's `locale`, else English.

**Platform notices** are what the console sends on the platform's account: an
approval to give, a link to connect an account or set a password, a meeting the
assistant waits in or has transcribed, a failure. They arrive on
`/internal/inject` with a `notice` and never start a turn. Each channel shows
one in its own box, signed «Cerase», with the link in a button: a Discord embed,
Slack blocks, a Google Chat card, and on Telegram a quoted block under a bold
heading. The address is spelled out wherever a button cannot be shown: the text
of a Slack or Google Chat notification, a link Discord or Telegram refuses as a
button, and the console's own transport, which receives the notice as text.
Rendering: `src/platform-notice.ts`.

Every channel and every injected message runs through this path
(`Dispatcher.handleMessage`). The debug CLI does not: it talks to the session
manager directly.

**Prompts the bridge writes on its own** (the two retries above, the correction after
a file that did not reach the person, the started-over block) open with one line
`[<what>_result: <outcome>]`, built by `src/bridge-prompt.ts`. opencode stores
them as user messages, and the console's chat view hides every user message that
opens with such a line. Every prompt carrying a person's words opens with the
`[turn_meta: …]` block instead, so nothing a person typed is hidden. The
examples both sides test against are `control-plane/tests/fixtures/bridge-prompts.json`,
a copy of cerase-core's, synced by `cerase-core/scripts/sync-tooling.sh` and
pinned in `scripts/TOOLING.sha256`: change them in cerase-core and re-sync.

### What leaves the bridge

Each reply chunk passes these steps, in order, before a channel sends it:

1. `{{APPROVAL_LINK}}` is replaced with the signed link to the agent's latest
   pending approval, fetched from `GET /api/internal/approval-pending-link`; the
   link never passes through the assistant. With no pending approval the
   placeholder is removed; when the fetch fails it is replaced by a note.
2. `[[attach: <path>]]` markers are removed from the text and the files they
   name are sent after it (see Files).
3. A reply that is opencode's internal summary block is withheld from the chat
   and posted to the control-plane as the assistant's rolling summary
   (`POST /api/internal/session-summary`).
4. The runtime's name, its config paths and the assistant identifying itself as
   a model or provider (Claude, GPT, OpenAI, Anthropic, DeepSeek, Gemini, Llama,
   Mistral) are rewritten. Code: `src/egress-redaction.ts`.
5. Tool-call markup left in the text is stripped; a chunk that was only markup
   is withheld.

All the control-plane calls on this page need `CERASE_INTERNAL_SECRET`. Without
it the bridge makes none of them: turns run without the credit check, the clock
and the summaries, and `{{APPROVAL_LINK}}` is left in the text.

### Files

- **From the person.** Files are written into the slot's workspace under
  `uploads/<timestamp>-<n>/<name>` and the message reaches the assistant prefixed
  with `[Uploaded files: <paths>]`, the marker its attachment skill reads. A
  file with no text is still delivered.
- **From the assistant.** The assistant writes
  `[[attach: <workspace-relative path>]]`; the bridge reads the file from the
  slot (`docker exec`, under
  `CERASE_AGENT_WORKSPACE_ROOT`, refusing paths outside it) up to the file-size
  limit and uploads it after the text it came with. Only Discord uploads files.
  On any other channel, and whenever an upload fails, the person is told the file
  did not arrive, the turn reports a failure, and the assistant is told what
  happened so it does not claim the file was delivered.
- Both directions address the slot as the container `cerase-<agent id>` (agent
  `agent-1` → `cerase-agent-1`), whatever the `spawn` command says.

### Workspace Chat

Every `workspace_chat` agent is its own Google Chat app, in its own Google Cloud
project, as every Discord agent is its own bot. Google calls `POST /chat/event` on
the listener for every app. The listener:

1. verifies the Bearer JWT Google signs against the project numbers of the
   registered agents, before reading the body; a request that fails gets a bare
   401;
2. answers a message outside a direct message with a short "direct messages
   only" notice, and ignores messages from other apps;
3. routes the message to the agent of that project whose `allowed_users` lists
   the sender's address (case-insensitive). Anybody else gets the refusal, and
   so does an address listed by two agents of the same app.

An accepted message is acknowledged at once with an empty body, because Google
shows an error after 30 seconds and a turn routinely takes longer. The app then
posts 💬 into the conversation (Chat offers an app no read receipt and no typing
indicator), and edits it to … with `spaces.messages.patch` once the first part of
the answer is posted, or when the turn ends without one. The answer is posted as
new messages with `spaces.messages.create` under the app's service account
(`chat.bot` scope), into the event's space and thread, so the phone's
notification carries the answer. A placeholder Google refuses to post or edit is
logged and the answer goes out regardless.

An answer is posted as one message once it is complete, because every Chat
message rings the person's phone. Text the assistant writes before it starts a
tool goes out as a message of its own when the tool starts. Markdown is
translated to Chat's markup (bold, italic, strike, code, `<url|text>` links,
headings as bold, bullets). An answer is split only when its Chat text exceeds
30,000 bytes (Google's limit is 32,000 per message; the rest is room for the
approval link), and every part but the last ends with ⏎. Writes into one space
are spaced one second apart, as Google requires, and a 429 is retried with
backoff.

A message with no event behind it (a scheduled message, a reply after a restart)
goes to the space the person last wrote from, kept in
`workspace-chat-spaces.json` in the state directory. For a person who never
wrote, the bridge uses the app's only direct-message space when it has exactly
one.

### Restarts and stops

- **The slot restarts under a turn.** A turn whose `docker exec` child dies with
  the slot's container, or that arrives while the container is down, is held and
  sent again, as the person wrote it, once the session is back: every 2 s for up
  to 60 s (`RESTART_HOLD_MS`). A closed ACP connection counts as a restart only
  when the bridge closed the session itself, or `docker inspect` shows the slot
  stopped, restarting, or started after the child was spawned; anything else
  fails the turn. A held turn counts in `turnsInFlight` and keeps its place:
  later messages of the same conversation wait for it. Past the limit the person
  is told the assistant is restarting and to send the message again. Code:
  `src/restart-hold.ts`, `Dispatcher.promptThroughRestarts`.
- **The bridge stops.** On SIGTERM or SIGINT it sends nothing new to the
  assistants and waits up to 180 s (`STOP_DRAIN_MS`) for the turns in flight,
  with the adapters and the internal server still up so their answers go out. A
  message that arrives meanwhile, or that has not yet reached the assistant, is
  acknowledged and kept in `pending-messages.json` in the state directory, in
  arrival order; with no state directory the person is told to send it again. A
  turn still running at the limit is ended and its person told, in their
  language, that an update interrupted the answer; it is not sent again, because
  the assistant may already have acted on it. The next bridge answers each kept
  message once, as soon as that agent's adapter is up, in the session the person
  was in and in order per person. The stop logs how many turns it waited for, for
  how long, how many it interrupted and how many messages it kept. **Give the
  container more than 200 s to stop** (`STOP_DRAIN_MS` plus `STOP_NOTICE_MS`,
  20 s), or it is killed before the notices go out; the appliance sets 220 s.
  Code: `Dispatcher.stop`, `src/pending-messages.ts`.

### Live configuration reload

The bridge watches the directory holding `agents.yaml` and reloads the file
50 ms after the last write, so a file replaced through a rename is seen. A file
that does not parse or validate is logged and ignored; the running configuration
stays. Reloads are applied one at a time: a file written again while a reload is
being applied is applied after it, against the configuration it left, and a stop
waits for the reload being applied before it stops the adapters. A valid file is
applied agent by agent:

| What changed | What the bridge does |
|---|---|
| only `allowed_users` | updates the allowlist in place |
| `channel`, `bot_token`, `slack_app_token`, `spawn`, `cwd`, `mode`, `model` or the `workspace_chat` block | stops the agent's adapter and sessions, and starts them again, on the new channel when that changed |
| an agent added or removed | starts or stops it |
| the `session` block | applies the new limits to the running session manager |
| `locale` | applies to the next notice the bridge writes |
| `max_file_mb` | applies the new limit to the next file |

### Failures and health

- **One channel down does not stop the others.** Each adapter starts on its own.
  A failed start is retried on a jittered backoff that starts at 5 s and doubles
  up to 5 minutes, without a container restart.
- **A credential Discord refuses is not retried.** A refused or missing token,
  or a bot whose application lacks the Message Content intent, stops the retries
  for that agent and is reported on `/internal/status` as the failure
  `credential_rejected`, naming the credential and what to fix. The agent is
  started again when its entry in `agents.yaml` changes or the bridge restarts.
- **No channel at all.** When every adapter fails to start and the internal
  server is configured, the bridge stays up to report it: `/healthz` answers 503
  and `/internal/status` names each agent's failure. Without the internal server
  it exits.
- **Discord reachability.** Each Discord adapter asks Discord's gateway endpoint
  every minute whether it is answering, and every message sent or received counts
  as an answer. After three minutes without one the adapter reports
  `ready: false`, even when the client still believes its socket is open.

### Internal HTTP endpoints

Served on `CERASE_ACP_INTERNAL_PORT` when `CERASE_ACP_INTERNAL_SECRET` is set.
Every route but `/healthz` requires `Authorization: Bearer <CERASE_ACP_INTERNAL_SECRET>`.

| Route | Purpose |
|---|---|
| `GET /healthz` | Unauthenticated liveness for the container healthcheck. `200 {status: "ok", adapters, ready, readyOf}`; `503 {status: "no_chat_transport"}` when every adapter reports itself down. Compare `ready` with `readyOf`: an agent whose channel has no readiness signal (Telegram, Slack, `web`) is counted in neither. |
| `GET /internal/status` | Per agent: `id`, `channel`, `attached`, `ready` (`true`, `false`, or `null` for a channel with no readiness signal), `lastContactAgeMs`, `turnsInFlight`, and `failure` when the bridge has stopped trying. Plus `inject` (in flight, succeeded, failed, last failure) and `session` (the limits in force). |
| `POST /internal/inject` | `{agent_id, user_id, text, surface_in_chat?, heads_up?, system_message_only?}`. Runs `text` as a message from that user and answers 202 as soon as it is accepted; the turn's outcome is in the log and the `inject` block of `/internal/status`. With `surface_in_chat` (default `true`) a heads-up is posted first: `heads_up` when given, otherwise a fixed Italian line quoting the scheduled message. With `system_message_only` the text is delivered as it is and no turn runs, and a failed delivery answers 500. With `system_message_only` and `notice: {title, body, link?: {url, label}}` the message is a platform notice, drawn in the channel's own box (below), and `text` is the same notice spelled out. 400 on a missing field, on a malformed notice and on a notice without `system_message_only`, 401 without the bearer, 403 for a user not in the agent's allowlist. |

## Configuration

`agents.yaml` is read from `CERASE_ACP_CONFIG` (default
`/etc/cerase-acp/agents.yaml`). `${env:VAR}` anywhere in the file is replaced with
that environment variable, and a reference to an unset one stops the load. Start
from `agents.yaml.example`.

On an appliance nobody edits this file: the control-plane writes it from the
console.

Top-level keys:

| Key | Required | Description |
|---|---|---|
| `agents` | yes | The agents. An empty list is valid: the bridge starts idle and picks agents up on reload. |
| `session` | yes | Session limits, below. |
| `locale` | no | `it`, `en`, `es` or `fr`: the language of the bridge's own notices when the person's messages have not shown theirs. |
| `max_file_mb` | no | The console's file-size limit, in MB, for files in both directions. Absent: `CERASE_MAX_ATTACHMENT_MB`, then 64. |

### Agent fields

| Field | Required | Default | Description |
|---|---|---|---|
| `id` | yes | — | Letters, digits and `-`, not starting with `-`; unique in the file. |
| `channel` | no | `discord` | `discord`, `telegram`, `slack`, `workspace_chat` or `web`. |
| `bot_token` | for `discord`, `telegram`, `slack` | — | Discord bot token, Telegram BotFather token, or Slack `xoxb-…` bot token. |
| `slack_app_token` | for `slack` | — | Slack `xapp-…` app-level token, for Socket Mode. |
| `workspace_chat` | for `workspace_chat` | — | The agent's Chat app, below. |
| `allowed_users` | yes | — | Who may talk to the agent. Discord: user ID. Telegram: numeric user ID. Slack: `U…` member ID. Workspace Chat: email address, matched case-insensitively. Web: any identifier the console uses. An empty list admits nobody. |
| `spawn.command`, `spawn.args` | yes | — | The command that starts one ACP child. Appliance: `docker` with `[exec, -i, cerase-<agent id>, opencode, acp]`. Local: `opencode` with `[acp]`. |
| `cwd` | no | `/home/agent/cerase/workspace` | The session's working directory, as seen by the ACP child (inside the slot on an appliance). |
| `mode` | no | `cerase` | The opencode mode, that is the primary agent, each session runs under. |
| `model` | no | — | The `provider/model` pair the assistant runs on. Only a resumed session uses it, to be set back to this model. |

A Discord, Telegram or Slack agent without its token fails the whole file's
validation. A `workspace_chat` agent with a missing or malformed block does not:
that agent refuses to start and names the problem, and the others run.

### Session settings

| Field | Required | Default | Description |
|---|---|---|---|
| `idle_timeout_minutes` | yes | — | Stop an ACP child idle this long; the next message spawns a new one. |
| `max_concurrent` | yes | — | Most ACP children at once; at the limit the least recently used is stopped. |
| `turn_silence_seconds` | no | 180 | End a turn whose stream has said nothing this long. |
| `turn_ceiling_minutes` | no | 45 | End a turn still running after this long. |

### The `workspace_chat` block

```yaml
agents:
  - id: agent-1
    channel: workspace_chat
    allowed_users: ["mario.rossi@example.com"]
    workspace_chat:
      project_number: "123456789012"
      credentials_path: /var/cerase/workspace-chat-creds/agent-1.json
    spawn: { command: docker, args: [exec, -i, cerase-agent-1, opencode, acp] }
```

| Field | Description |
|---|---|
| `project_number` | The Google Cloud project number of the agent's Chat app, digits only (a YAML integer is accepted). Google puts it in every event's JWT as the audience, so the app's *Authentication Audience* must be set to *Project Number*. |
| `credentials_path` | Path, inside the container, of the app's service-account JSON key. It is read at start, so an unreadable key stops the agent with the path and the reason, and read again whenever an access token is renewed, so a replaced key is used without a restart. The bridge needs read permission on the file and search permission on its directory, as uid 1000 or one of its groups; it never writes there. |
| `certificates_url` | Optional. Where the certificates Chat signs events with are fetched; Google's address when absent. |
| `api_root` | Optional. Base URL of the Chat API; `https://chat.googleapis.com` when absent. |

`certificates_url` and `api_root` exist so a test can serve Google's endpoints
itself. Each, and the `token_uri` the key names, must be an `https` URL, or an
`http` URL to a host name without a dot or to a loopback address; a value outside
that rule keeps the agent from starting, and the log names the key and the value.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `CERASE_ACP_CONFIG` | `/etc/cerase-acp/agents.yaml` | The configuration file. |
| `CERASE_ACP_STATE_DIR` | `/var/lib/cerase-acp/state` in the image; unset outside it | Where `resumable-sessions.json`, `pending-messages.json` and `workspace-chat-spaces.json` are kept. Unset: the first two live in memory only, and messages arriving during a stop are not kept. |
| `CERASE_ACP_LOG_LEVEL` | `info` | pino level; `silent` mutes the logs. Logs go to stderr. |
| `CERASE_ACP_INTERNAL_SECRET` | unset | The bearer the internal endpoints require. Unset: the internal server, including `/healthz`, does not start. |
| `CERASE_ACP_INTERNAL_PORT` | `7476` | Port of the internal server. |
| `CERASE_INTERNAL_SECRET` | unset | The bearer the bridge presents to the control-plane. It is not `CERASE_ACP_INTERNAL_SECRET`, which is the one the bridge demands. |
| `CERASE_CONTROL_PLANE_URL` | `http://cerase-control-plane:8000` | Where the control-plane's internal API is. |
| `WORKSPACE_CHAT_PORT` | `7475` | Port of the Workspace Chat webhook listener. |
| `CERASE_AGENT_WORKSPACE_ROOT` | `/home/agent/cerase/workspace` | The workspace directory inside a slot, for files in both directions. |
| `CERASE_MAX_ATTACHMENT_MB` | `64` | File-size limit when `agents.yaml` has no `max_file_mb`. |
| `CERASE_ACP_ADAPTER_RETRY_BASE_MS` | `5000` | First retry delay after an adapter fails to start. |
| `CERASE_ACP_ADAPTER_RETRY_MAX_MS` | `300000` | Longest retry delay. |
| `CERASE_ACP_REACHABILITY_INTERVAL_MS` | `60000` | How often a Discord adapter probes Discord's gateway endpoint. |
| `CERASE_ACP_REACHABILITY_STALE_MS` | `180000` | How long Discord may stay silent before the adapter reports `ready: false`. |
| `CERASE_ACP_STOP_DRAIN_MS` | `180000` | How long a stop waits for turns in flight. Meant for tests. |
| `BRIDGE_E2E_TEST` | unset | `1` starts the test-injection server on 127.0.0.1:7474 and disables adapter retries. The bridge logs a warning when it is set. Never in production. |

Channel credentials are not environment variables: they are in `agents.yaml`,
directly or through `${env:VAR}`.

## Develop

```bash
npm ci
npm run build        # tsc → dist/, the shipped code only
npm test             # vitest, including a type check of the tests
npm run lint         # biome, then tsc over code and tests
npm run format       # biome, writing fixes
npm run dev          # run the daemon from source with tsx
```

The suite needs no Docker, chat platform or network. Tests sit beside the code
as `src/**/*.test.ts`. `src/__tests__/fake-acp-child.mjs` stands in for
`opencode acp`, so the session manager is tested over real ACP stdio;
`src/__tests__/fake-google.ts` serves Google's token, certificate and Chat
endpoints for the Workspace Chat tests. `tsconfig.json` builds only the shipped
code; `tsconfig.test.json` covers the tests too, and `src/typecheck.test.ts` runs
it inside `npm test`. `npm run typecheck` runs that check alone.

The end-to-end tier against a real stack (LiteLLM, opencode and the bridge) is
`cerase-core/tests/e2e-discord/`; it drives the bridge through the
`BRIDGE_E2E_TEST` endpoint.

**Files you must not edit here.** `scripts/docs-parity.sh`,
`scripts/comment-check.sh`, `scripts/secrets-guard.sh`,
`scripts/_secret_renames.sh`, `scripts/_registry_images.sh`,
`scripts/ghcr-retention.sh`, `.github/workflows/publish-self-heal.yml`,
`.github/workflows/dependabot-auto-merge.yml` and
`control-plane/tests/fixtures/bridge-prompts.json` are copies of cerase-core's,
pinned by hash in `scripts/TOOLING.sha256`. CI fails when a copy differs; change
them in cerase-core and re-sync with `cerase-core/scripts/sync-tooling.sh`.

### Try it without Docker or a chat platform

Use a `web` agent, a local `opencode` and the debug CLI:

```yaml
# agents.yaml
agents:
  - id: local
    channel: web
    allowed_users: ["me"]
    spawn:
      command: opencode
      args: [acp]
    cwd: /path/to/a/project
session:
  idle_timeout_minutes: 60
  max_concurrent: 4
```

```bash
npm run build

# one round trip
./scripts/cerase-acp-cli prompt --config agents.yaml --agent local --user me "hello"

# a conversation: one ACP child kept alive across turns, as the daemon keeps it
./scripts/cerase-acp-cli repl --config agents.yaml --agent local --user me

# a running daemon started with BRIDGE_E2E_TEST=1
./scripts/cerase-acp-cli inject --remote http://127.0.0.1:7474 --agent local --user me "hello"
```

`prompt` and `repl` require `--config`, `--agent` and `--user`; a user not in the
allowlist gets the refusal and exit code 0. They stream the answer to stdout and
the assistant's reasoning, dimmed, to stderr; when a turn produces reasoning and
no answer, stdout says so. When text missing from the ACP stream was recovered
from opencode's REST API, stderr says how many bytes. `inject` needs `curl` and
`jq`. `CERASE_ACP_LOG_LEVEL=silent` or `2>/dev/null` silences the logs. The CLI
uses the session manager directly, so the dispatcher's behaviour (credit check,
egress filters, restart hold) is not exercised.

### Run it on Discord

1. In the [Discord Developer Portal](https://discord.com/developers/applications),
   create an application, open **Bot** and use **Reset Token** to get the token.
2. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**.
   It is the only privileged intent the bridge asks for; without it the login
   fails with `Used disallowed intents` and the agent is reported as
   `credential_rejected`.
3. Under **OAuth2 → URL Generator**, select the `bot` scope, open the generated
   URL and add the bot to a server its users belong to, so they can find it and
   open a direct message with it. The bot reads nothing posted in the server.
4. In Discord, enable **Settings → Advanced → Developer Mode**, right-click your
   name and **Copy User ID**.
5. Write `agents.yaml`:

   ```yaml
   agents:
     - id: my-agent
       channel: discord
       bot_token: ${env:CERASE_DISCORD_BOT_TOKEN}
       allowed_users: ["123456789012345678"]
       spawn:
         command: opencode
         args: [acp]
       cwd: /path/to/a/project
   session:
     idle_timeout_minutes: 60
     max_concurrent: 4
   ```

6. Start the daemon, typing the token at a hidden prompt so it stays out of
   files and shell history:

   ```bash
   read -rs -p 'Discord bot token: ' CERASE_DISCORD_BOT_TOKEN && echo && export CERASE_DISCORD_BOT_TOKEN
   CERASE_ACP_CONFIG=./agents.yaml npm start
   ```

The log shows `cerase-acp bridge ready` with the number of adapters started. Send
the bot a direct message. Ctrl+C stops it, after the drain described above.

Against a local `opencode`, files do not work in either direction (they address
a container named `cerase-<agent id>`), and the slot-restart hold and the
recovery of dropped text, which look the slot up through `docker`, find nothing
to act on.

## Release

| Workflow | Trigger | What it does |
|---|---|---|
| `.github/workflows/docker-publish.yml` | push to `main` (unless only `devplan/` changed), `v*` tag, manual | Runs `ci.yml` as a gate, builds the image, scans it with Trivy (a fixable HIGH or CRITICAL finding blocks), and pushes `ghcr.io/cerase-ai/cerase-acp` tagged `latest`, `main` and `sha-<short>`; a `v*` tag pushes its semver tags. |
| `.github/workflows/ci.yml` | pull request, and as the gate above | Vendored-tooling pin, docs parity, comment convention, secrets guard, gitleaks over the history, biome, `npm run build`, `npm test`. On a pull request, also a Trivy scan of a fresh build. |
| `.github/workflows/publish-self-heal.yml` | daily, manual | Starts the publish again for the newest `main` commit that should have an image and has no publish run, or only a cancelled one. |
| `.github/workflows/ghcr-retention.yml` | weekly, manual (with a dry run) | Deletes old image versions, keeping the newest 10 tagged ones, `latest`, `main` and every tag a Fleet Console release pins. |
| `.github/workflows/dependabot-auto-merge.yml` | Dependabot pull requests | Queues patch and minor updates to merge once the checks pass. |

Nothing is built on an appliance. Its compose pulls the image by tag, and from a
`cerase-core` checkout `./cli.sh update cerase-acp` brings a box onto the latest
published image. To try a change without waiting for CI, `./cli.sh build cerase-acp`
in `cerase-core` builds this checkout onto the same GHCR reference the compose
resolves.

## Further reading

The source comments are the detailed documentation; the modules by topic:

| Topic | Code |
|---|---|
| Wiring, egress filters, adapter start and retry, reload | `src/bridge.ts` |
| A turn from message to notices; stop drain | `src/dispatcher.ts` |
| ACP children, resume, watchdog, eviction | `src/session-manager.ts` |
| Channels | `src/discord-adapter.ts`, `src/telegram-adapter.ts`, `src/slack-adapter.ts`, `src/workspace-chat-adapter.ts`, `src/web-adapter.ts` |
| Internal endpoints | `src/internal-server.ts` |
| Configuration schema | `src/config.ts` |

For people with access to `cerase-core`, the operator guides are
`cerase-core/docs/operator/discord-setup.md`, `cerase-core/docs/operator/telegram-setup.md`,
`cerase-core/docs/operator/slack-setup.md`, `cerase-core/docs/operator/workspace-chat-setup.md`
and `cerase-core/docs/operator/bridge-liveness.md`. Open work on this repo is in
[`devplan/v0.1.md`](devplan/v0.1.md).

## Troubleshooting

**`config references ${env:VAR} but the environment variable is not set`.** The
file names a variable the daemon's environment does not have. Export it in the
shell that starts the daemon, or pass it to the container.

**`Used disallowed intents`, or `credential_rejected` with code
`DisallowedIntents`.** The Discord application does not have the Message Content
intent. Enable it under **Bot → Privileged Gateway Intents**, then restart the
bridge: a refused credential is not retried.

**A `workspace_chat` agent does not start.** The log line names the agent and
the problem: a missing `project_number` or `credentials_path`, a key the process
cannot read (with its uid and groups), or an endpoint outside the rule above.

## Licence and security

MIT, published by Guidance Studio S.r.l.; see [`LICENSE`](LICENSE). The
repository is public. Report a vulnerability privately as described in
[`SECURITY.md`](SECURITY.md), never in an issue or pull request.

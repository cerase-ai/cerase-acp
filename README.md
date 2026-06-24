# cerase-acp

In-house chat-to-[ACP](https://agentclientprotocol.com/) DM bridge for
[Cerase](https://github.com/cerase-ai/cerase-core) — Discord, Telegram,
Slack, and Google Workspace Chat.

This is the **single TypeScript artefact** in the Cerase stack. It lives
in its own repository so its build pipeline (npm, tsc, vitest) does not
leak into the otherwise-bash/Python/PHP `cerase/` repo. Cerase consumes
this repo as a published Docker image (`cerase-acp:<tag>`), the same way
it consumes OpenCode and LiteLLM.

## What it does

For each configured agent template:
- Connects the chat adapter selected by the agent's `channel:` key in
  `agents.yaml` — `discord` (default; `discord.js` Client, DM intent
  only — no guild channels, no slash commands, no buttons), `telegram`
  (`telegraf`), `slack` (`@slack/bolt`), `workspace_chat` (Google
  Workspace Chat via `googleapis`), or `web` — with the bot
  token / credentials bound to that template.
- On an inbound DM: checks the per-agent `user_id` allowlist;
  authorised → routes to a long-lived ACP session for the
  `(user, agent)` pair; unauthorised → polite refusal.
- Spawns `opencode acp` lazily on first DM via the configured spawn
  command (PoC: `docker exec -i cerase-agent-<id> opencode acp`); the
  child persists across multiple DMs from the same user and survives
  bridge restarts via mem0 + the persisted workspace.
- Prepends a `[turn_meta: gap=…, lang=…]` block to each
  `session/prompt`. The agent reads this per the system-prompt rules
  in `cerase/agent-runtime/agent/srv/AGENTS.md`.

## Architecture (PoC v0.1)

```
   Discord                 cerase-acp                    cerase-agent-<id>
   ───────                 ──────────                    ─────────────────
   DM event   ───────────► discord.js Client
                          │
                          ▼
                          allowlist check ──► refuse if unauthorised
                          │
                          ▼
                          SessionManager
                          │   ├─ key = (agent_id, user_id)
                          │   ├─ spawn or reuse
                          │   └─ prompt queue
                          ▼
                          ACP stdio NDJSON  ◄──► opencode acp (subprocess)
                          │
                          ▼
                          StreamBuffer + SendQueue
                          │
                          ▼
   DM reply  ◄─────────── discord.js Client.send()
```

## Quick local setup (no Docker, no chat platform)

You don't need Docker, Discord, or any chat platform to test cerase-acp
end-to-end. Use `channel: web` (no credentials required) and point
`spawn` at your local `opencode` binary.

**1. Create a minimal `agents.yaml`:**

```yaml
agents:
  - id: local
    channel: web
    allowed_users:
      - "me"
    spawn:
      command: opencode
      args: [acp]
    cwd: /home/yourname/projects   # ACP session working directory

session:
  idle_timeout_minutes: 60
  max_concurrent: 4
```

**2. Build and test:**

```bash
npm ci && npm run build

# one-shot prompt
./scripts/cerase-acp-cli prompt \
  --config agents.yaml --agent local --user me "hello"

# interactive REPL (single ACP child kept alive across turns —
# conversation history works just like a real DM thread)
./scripts/cerase-acp-cli repl \
  --config agents.yaml --agent local --user me
```

To silence pino logs: `CERASE_ACP_LOG_LEVEL=silent` or `2>/dev/null`.

## Configuration

Create an `agents.yaml` (copy from `agents.yaml.example`). Each agent
is a typed template declaring its chat channel, credentials, allowlist
of authorised users, ACP spawn command, and optional working directory.

The daemon reads the config path from `CERASE_ACP_CONFIG` (default:
`/etc/cerase-acp/agents.yaml` in the container, `./agents.yaml` for local
CLI). Env vars in the config use `${env:VAR_NAME}` substitution.

### Supported channels

| Channel | Required credentials | Adapter | Notes |
|---------|---------------------|---------|-------|
| `discord` (default) | `bot_token` | `discord.js` Client, DM-only | Gateway Intents must be enabled in Developer Portal |
| `telegram` | `bot_token` | `telegraf` | BotFather token; DMs only |
| `slack` | `bot_token` + `slack_app_token` | `@slack/bolt` Socket Mode | `xoxb-…` bot token + `xapp-…` app-level token |
| `workspace_chat` | `workspace_chat_credentials_path` | Google Workspace Chat API | Path to service-account JSON inside the container |
| `web` | *none* | Null-sink adapter | For local dev, CLI testing, and panel-only agents |

### Agent fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `id` | yes | — | Alphanumeric + `-`. Must be unique. |
| `channel` | no | `discord` | One of the channels above. |
| `bot_token` | per channel | — | See channel table. Use `${env:VAR}` for env-var substitution. |
| `allowed_users` | yes | — | List of user IDs authorised to DM this agent. Discord: snowflake string. Telegram: numeric chat ID. Slack: `U…` workspace ID. Web: any synthetic ID. |
| `spawn.command` | yes | — | Command to start one ACP child. Container: `docker`. Local: `opencode` or path to binary. |
| `spawn.args` | yes | — | Args passed to `spawn.command`. Container: `[exec, -i, cerase-agent-<id>, opencode, acp]`. Local: `[acp]`. |
| `cwd` | no | `/root/cerase/workspace` | Working directory passed to the ACP child via `session/new`. For local installs, point this at a real project directory. |

### Session settings

| Field | Default | Description |
|-------|---------|-------------|
| `idle_timeout_minutes` | 60 | Kill an idle ACP child after this many minutes; respawn on next DM. |
| `max_concurrent` | 16 | Safety ceiling on concurrent `(user, agent)` ACP sessions. |

### Operational environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CERASE_ACP_CONFIG` | `/etc/cerase-acp/agents.yaml` | Path to the config the daemon loads. |
| `CERASE_ACP_LOG_LEVEL` | `info` | pino level. `silent` mutes logs (CLI pipelines). |
| `CERASE_ACP_INTERNAL_SECRET` | *(unset)* | Shared bearer for the internal server. When set, `/internal/inject` + `/internal/status` start (both require the bearer). |
| `CERASE_ACP_INTERNAL_PORT` | `7476` | Port for the internal server. |
| `CERASE_ACP_ADAPTER_RETRY_BASE_MS` | `5000` | Self-heal: first retry delay for an adapter whose `start()` failed. Doubles each attempt (half-jittered). |
| `CERASE_ACP_ADAPTER_RETRY_MAX_MS` | `300000` | Self-heal: cap on the retry backoff interval. |

**Adapter resilience.** A single channel adapter that fails to start (e.g. an
invalid Discord token) no longer tears the bridge down — it stays not-ready
while every other channel (and the panel-only `web` transport + the internal
server) keeps serving. A failed channel adapter is then retried automatically on
the capped, jittered backoff above until it connects, with no container restart.
The bridge only exits when *every* adapter fails to start (no working transport).

## Discord setup

### 1. Create a Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**, give it a name
3. Go to the **Bot** tab (left sidebar)
4. Click **Reset Token** → copy the token
5. Store it as an env var (the config reads `${env:CERASE_DISCORD_BOT_TOKEN}`):

```bash
read -s -p 'Discord bot token: ' TOKEN && echo && \
  echo "export CERASE_DISCORD_BOT_TOKEN=$TOKEN" >> ~/.bashrc && \
  source ~/.bashrc && unset TOKEN
```

### 2. Enable Gateway Intents

In the **Bot** tab, scroll to **Privileged Gateway Intents** and enable:

| Intent | Why |
|--------|-----|
| **MESSAGE CONTENT INTENT** | Required to read the text of incoming DMs |
| **SERVER MEMBERS INTENT** | Required for `client.users.fetch()` to resolve DM channels |
| **PRESENCE INTENT** | Not needed — leave off |

*Note: if you see `Error: Used disallowed intents` on startup, one of
these is still disabled.*

### 3. Generate the OAuth2 invite URL

1. Go to **OAuth2** (left sidebar)
2. Under **Scopes**, check:
   - `bot`
   - `applications.commands`
3. Under **Bot Permissions**, check:
   - `Send Messages`
   - `Read Message History`
   - `Attach Files`
   - `Add Reactions`
4. Copy the generated URL at the bottom, open it in a browser, and
   authorise the bot on a server (or skip this — users can DM the bot
   directly without it being in any server).

### 4. Get your Discord user ID

1. In Discord, go to **Settings → Advanced** → enable **Developer Mode**
2. Right-click your username anywhere → **Copy ID**
3. Paste the ID into `agents.yaml` under `allowed_users`

### 5. Example agents.yaml for Discord

```yaml
agents:
  - id: my-agent
    channel: discord
    bot_token: ${env:CERASE_DISCORD_BOT_TOKEN}
    allowed_users:
      - "123456789012345678"   # your Discord user ID
    spawn:
      command: opencode
      args: [acp]
    cwd: /home/yourname/projects

session:
  idle_timeout_minutes: 60
  max_concurrent: 4
```

### 6. Start the daemon

```bash
node dist/index.js
```

The bridge logs the agent count on startup. Send a DM to your bot —
it should reply through the ACP pipeline. Press Ctrl+C to shut down.

## Build + run (local dev)

```bash
npm ci
npm run build
node dist/index.js
```

For container builds:

```bash
docker build -t cerase-acp:0.1.0-dev .
```

## Debug CLI

A standalone CLI exercises the bridge pipeline (allowlist → turn-meta
→ session-manager) for a single round-trip — no Discord, no compose,
no test-injection HTTP server. Useful for isolated debugging against
either the fake-acp-child fixture or a real `opencode acp`.

```bash
# build first
npm run build

# one-shot prompt (uses agents.yaml in cwd by default; override with --config)
./scripts/cerase-acp-cli prompt \
  --config agents.yaml --agent doc-qa --user 123456789012345678 "ciao"

# interactive REPL — single ACP child kept alive across all turns
# (M13: mirrors the production Discord daemon's lifecycle, so
# conversation history works just like a real DM thread)
./scripts/cerase-acp-cli repl \
  --config agents.yaml --agent doc-qa --user 123456789012345678

# poke a running bridge daemon's BRIDGE_E2E_TEST endpoint
./scripts/cerase-acp-cli inject \
  --remote http://localhost:7474 --agent doc-qa --user 123456789012345678 "test"
```

To silence the pino logs that interleave with the streamed reply:

```bash
CERASE_ACP_LOG_LEVEL=silent ./scripts/cerase-acp-cli prompt ...
```

Note: pino logs go to stderr (M10), so you can also just `2>/dev/null`
to drop them without touching the log level.

The bash wrapper keeps the TypeScript surface lean — TS handles only
the one-shot path; the REPL loop and the remote-daemon HTTP dance live
in the wrapper (`scripts/cerase-acp-cli`), out of the compiled bundle.

### Thought-fallback (M11)

When the agent burns its output budget entirely on chain-of-thought
reasoning and emits zero `agent_message_chunk` (observed with
deepseek-v4-flash on short conversational prompts via `opencode acp`),
the CLI surfaces the accumulated `agent_thought_chunk` content on
stdout, prefixed by a one-line preamble on stderr:

```
$ ./scripts/cerase-acp-cli prompt … "ciao amico, come stai?"
(no direct reply — surfacing the agent's thought process instead)   ← stderr
The user greeted me in Italian: "Hello friend, how are you?" I should …   ← stdout
```

The same model in `opencode`'s interactive shell does produce a
message chunk for the same prompt — this is an opencode-acp-mode
quirk we work around at the CLI layer.

## Tests

```bash
npm test
```

vitest. Tests live alongside source as `src/**/*.test.ts`. The
`src/__tests__/fake-acp-child.ts` fixture lets the session-manager
tests exercise the full ACP stdio loop without OpenCode or LiteLLM
running.

End-to-end tests against a real Compose stack (LiteLLM + opencode +
bridge) live in `cerase/tests/e2e-discord/` and drive the bridge via
the `BRIDGE_E2E_TEST` injection endpoint.

## Troubleshooting

### `config references ${env:VAR} but the environment variable is not set`

The daemon tried to start but the env var referenced in `agents.yaml` is
missing from the current shell environment. This happens when you add
the variable to `~/.bashrc` but haven't reloaded your shell.

```bash
source ~/.bashrc   # reload, then retry
```

### `Error: Used disallowed intents` (Discord)

One or more Gateway Intents are disabled in the Discord Developer Portal.
Go to your application → **Bot** → **Privileged Gateway Intents** and
enable all three required intents (see the [Gateway Intents
section](#2-enable-gateway-intents) above). Restart the daemon after
saving.

## License

Private — Guidance Studio. Pending open-source decision (see umbrella
roadmap in `cerase/devplan/v0.x.md`).

## Status

PoC v0.1 — see [`devplan/v0.1.md`](devplan/v0.1.md).

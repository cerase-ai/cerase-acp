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

## Configuration

Operators copy `agents.yaml.example` to `agents.yaml` and edit. The
container expects the path at `/etc/cerase-acp/agents.yaml` (mounted
read-only). See `agents.yaml.example` for the schema.

Required env (per agent template):

- `DISCORD_BOT_TOKEN_<AGENT_ID>` — referenced in `agents.yaml` as
  `${env:DISCORD_BOT_TOKEN_<AGENT_ID>}`.

Optional env:

- `BRIDGE_E2E_TEST=1` — enables the test-injection HTTP endpoint on
  `:7474`. **Never set in production.** Used only by cerase's
  `tests/e2e-discord/` to drive end-to-end tests without real Discord
  traffic.

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

## License

Private — Guidance Studio. Pending open-source decision (see umbrella
roadmap in `cerase/devplan/v0.x.md`).

## Status

PoC v0.1 — see [`devplan/v0.1.md`](devplan/v0.1.md).

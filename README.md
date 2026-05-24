# cerase-acp

In-house Discord-to-[ACP](https://agentclientprotocol.com/) bridge for
[Cerase](https://gitlab.com/guidance-studio/software/cerase).

This is the **single TypeScript artefact** in the Cerase stack. It lives
in its own repository so its build pipeline (npm, tsc, vitest) does not
leak into the otherwise-bash/Python/PHP `cerase/` repo. Cerase consumes
this repo as a published Docker image (`cerase-acp:<tag>`), the same way
it consumes OpenCode and LiteLLM.

## What it does

For each configured agent template:
- Connects a `discord.js` Client (DM intent only — no guild channels,
  no slash commands, no buttons) with the bot token bound to that
  template.
- On `messageCreate` (DM): checks the per-agent `user_id` allowlist;
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

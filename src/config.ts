import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// Agent ids end up in container names, log keys, and `docker exec`
// targets — restrict to a portable identifier shape so the operator
// gets a clean error at boot rather than a confusing `docker exec`
// failure at first DM.
const AgentIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/i, {
    message: "agent id must be alphanumeric + '-' (no spaces, no leading dash)",
  });

// CHANNEL-1 (2026-05-31): the bridge is no longer Discord-only. Each
// agent declares which chat channel it speaks via `channel` (default
// 'discord' for back-compat with every existing agents.yaml). Per-channel
// credential fields are flat on the agent (rather than nested under a
// `<channel>:` block) so the env-substitution helper continues to work
// without nesting awareness, and zod's superRefine validates that the
// fields required by the selected channel are present.
//
// The substitution / refinement matrix:
//   channel='discord'        → bot_token required (Discord bot token)
//   channel='telegram'       → bot_token required (BotFather token)
//   channel='slack'          → bot_token + slack_app_token required
//                              (bot token = xoxb-…, app token = xapp-…
//                              for Socket Mode)
//   channel='workspace_chat' → workspace_chat_credentials_path required
//                              (path inside the bridge container to a
//                              Google Cloud service-account JSON)
//   channel='web'            → NO credentials (C2-0). A panel-only agent
//                              (e.g. the maintainer assistant): turns arrive
//                              via /internal/inject and the reply is read
//                              from the opencode timeline in Filament — no
//                              external chat client, a null-sink adapter.
//
// allowed_users semantics per channel:
//   discord  → snowflake user id (numeric string)
//   telegram → numeric chat_id (string)
//   slack    → "U…" workspace user id
//   workspace_chat → email address (must match Workspace domain)
//   web      → a synthetic, deterministic user id (e.g. "maintainer:<orgId>")
export const ChatChannelSchema = z.enum(["discord", "telegram", "slack", "workspace_chat", "web"]);
export type ChatChannel = z.infer<typeof ChatChannelSchema>;

const AgentSchema = z
  .object({
    id: AgentIdSchema,
    channel: ChatChannelSchema.default("discord"),
    bot_token: z.string().optional(),
    slack_app_token: z.string().optional(),
    workspace_chat_credentials_path: z.string().optional(),
    allowed_users: z.array(z.string().min(1)),
    // Working directory advertised to the ACP child via `session/new`.
    // MUST be a path that exists INSIDE the agent container — passing
    // process.cwd() leaks the host/bridge path into a context where it
    // means nothing (the agent has no view of the host filesystem).
    // Default is the canonical Cerase workspace under the container's
    // HOME (`~/cerase/workspace`), namespaced consistently with
    // `~/cerase/data` for OpenCode's SQLite WAL. Override if your
    // agent image mounts the workspace elsewhere.
    cwd: z.string().min(1).default("/home/agent/cerase/workspace"),
    spawn: z.object({
      command: z.string().min(1),
      args: z.array(z.string()),
    }),
  })
  .superRefine((agent, ctx) => {
    const need = (field: keyof typeof agent, reason: string) => {
      const v = agent[field];
      if (typeof v !== "string" || v.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: reason,
        });
      }
    };
    switch (agent.channel) {
      case "discord":
        need("bot_token", "channel='discord' requires bot_token (Discord bot token)");
        break;
      case "telegram":
        need("bot_token", "channel='telegram' requires bot_token (BotFather token)");
        break;
      case "slack":
        need("bot_token", "channel='slack' requires bot_token (xoxb-… bot token)");
        need("slack_app_token", "channel='slack' requires slack_app_token (xapp-… app-level token for Socket Mode)");
        break;
      case "workspace_chat":
        need(
          "workspace_chat_credentials_path",
          "channel='workspace_chat' requires workspace_chat_credentials_path (path inside the container to the Google service-account JSON)",
        );
        break;
    }
  });

const SessionSchema = z.object({
  idle_timeout_minutes: z.number().int().positive(),
  max_concurrent: z.number().int().positive(),
});

const BridgeConfigSchema = z
  .object({
    // M-auto-reload (v0.2): zero agents is a valid bootstrap state.
    // The bridge starts idle and ConfigReloader brings in agents as
    // the operator wires them up — no more "first you have to seed an
    // agent.yaml entry to make the bridge boot" friction. The cerase
    // appliance always renders `agents: []` when there are no
    // renderable Agents (RegenAgentsYaml), and the bridge must
    // tolerate this without crash-looping.
    agents: z.array(AgentSchema),
    session: SessionSchema,
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    for (const a of cfg.agents) {
      if (seen.has(a.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["agents"],
          message: `duplicate agent id "${a.id}" — agent ids must be unique`,
        });
      }
      seen.add(a.id);
    }
  });

export type AgentConfig = z.infer<typeof AgentSchema>;
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

// Replaces every `${env:VAR}` token in `raw` with `env[VAR]`. Throws when
// a referenced variable is absent from `env` so a missing token surfaces
// at config-load time, not at first message dispatch.
export function resolveEnvSubstitutions(raw: string, env: Record<string, string | undefined>): string {
  return raw.replace(/\$\{env:([A-Z0-9_]+)\}/g, (_, name: string) => {
    const value = env[name];
    if (value === undefined || value === "") {
      throw new Error(`config references \${env:${name}} but the environment variable is not set`);
    }
    return value;
  });
}

// Loads `agents.yaml` from `path`, resolves env substitutions against
// `env` (defaults to `process.env`), parses YAML, validates with zod.
// Throws with operator-readable error messages on any failure mode.
export function loadConfig(path: string, env: Record<string, string | undefined> = process.env): BridgeConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot read agents.yaml at ${path}: ${msg}`);
  }

  const substituted = resolveEnvSubstitutions(raw, env);

  let parsed: unknown;
  try {
    parsed = parseYaml(substituted);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`agents.yaml is not valid YAML: ${msg}`);
  }

  const result = BridgeConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`).join("\n");
    throw new Error(`agents.yaml schema validation failed:\n${issues}`);
  }
  return result.data;
}

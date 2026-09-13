import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { CERASE_SESSION_MODE } from "./session-mode.js";

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

// The bridge is no longer Discord-only. Each
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
//   channel='workspace_chat' → nothing per agent. One Chat app serves the
//                              whole organisation, so its key, project
//                              number and domains are the top-level
//                              `workspace_chat` block (see below).
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
//   workspace_chat → the user's Google Workspace email address
//   web      → a synthetic, deterministic user id (e.g. "maintainer:<orgId>")
export const ChatChannelSchema = z.enum(["discord", "telegram", "slack", "workspace_chat", "web"]);
export type ChatChannel = z.infer<typeof ChatChannelSchema>;

const AgentSchema = z
  .object({
    id: AgentIdSchema,
    channel: ChatChannelSchema.default("discord"),
    bot_token: z.string().optional(),
    slack_app_token: z.string().optional(),
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
    // Which of the slot's primary agents this session runs under.
    //
    // opencode exposes its primary agents as ACP session modes and `opencode
    // acp` has no flag to pick one, so the mode IS the agent selector. It was a
    // constant until the health probe needed an assistant of its own: the probe
    // asks the maintainer to answer one word and the maintainer, reasonably,
    // answers a paragraph, so nothing could be asserted about the reply.
    //
    // Defaulted rather than required, and that is what keeps this backwards
    // compatible in both directions. A config written before this field existed
    // loads unchanged and asks for the same mode it always did; a config that
    // names one the slot does not define is refused per agent, with the modes
    // the slot does offer in the message, exactly as an absent `cerase` already
    // was.
    mode: z.string().min(1).default(CERASE_SESSION_MODE),
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
    }
  });

const SessionSchema = z.object({
  idle_timeout_minutes: z.number().int().positive(),
  max_concurrent: z.number().int().positive(),
});

// The organisation's one Google Chat app. Every field is optional here and
// checked by the adapter's start(), for the same reason the per-channel
// credentials are checked per agent: a requirement at this level would fail
// the whole file, and with it the panel-only maintainer and every reload.
const WorkspaceChatAppSchema = z.object({
  // The Google Cloud project number of the Chat app: the audience of the JWT
  // Google attaches to every event. Accepted as a YAML integer too, since a
  // renderer that casts the column writes a bare number for the same project.
  project_number: z
    .union([z.string(), z.number().int()])
    .transform((v) => String(v))
    .optional(),
  // Path, inside the bridge container, of the app's service-account key.
  credentials_path: z.string().optional(),
  // Email domains of the organisation. A sender outside them is refused even
  // when an assistant lists their address.
  allowed_domains: z.array(z.string()).optional(),
});
export type WorkspaceChatAppConfig = z.infer<typeof WorkspaceChatAppSchema>;

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
    workspace_chat: WorkspaceChatAppSchema.optional(),
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
  })
  // The app block is handed to each workspace_chat agent. An adapter is
  // started, stopped and respawned per agent, and the reload diff compares
  // agents: a key or project number that lived only at the top would change on
  // disk and reach no running adapter.
  //
  // It also stays at the top level, for the webhook listener. Google calls the
  // app's route for anybody in the organisation's domain, including somebody
  // with no assistant, and with no workspace_chat agent there is no copy to
  // verify that call against.
  .transform(({ workspace_chat, ...cfg }) => ({
    ...cfg,
    agents: cfg.agents.map(
      (a): AgentConfig => (a.channel === "workspace_chat" && workspace_chat ? { ...a, workspace_chat } : a),
    ),
    ...(workspace_chat ? { workspace_chat } : {}),
  }));

export type AgentConfig = z.infer<typeof AgentSchema> & {
  /** The organisation's Chat app, present only on a workspace_chat agent. */
  workspace_chat?: WorkspaceChatAppConfig;
};
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

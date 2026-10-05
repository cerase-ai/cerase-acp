import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { setConsoleFileLimitMb } from "./file-limit.js";
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

// Each agent declares which chat channel it speaks via `channel` (default
// 'discord'). The Discord, Telegram and Slack credential fields are flat on
// the agent, and zod's superRefine validates that the fields required by the
// selected channel are present; a workspace_chat agent's app is its nested
// `workspace_chat` block, checked when its adapter starts.
//
// The substitution / refinement matrix:
//   channel='discord'        → bot_token required (Discord bot token)
//   channel='telegram'       → bot_token required (BotFather token)
//   channel='slack'          → bot_token + slack_app_token required
//                              (bot token = xoxb-…, app token = xapp-…
//                              for Socket Mode)
//   channel='workspace_chat' → the assistant's own Chat app, in its
//                              `workspace_chat` block: project number and
//                              key path. Checked when the adapter starts,
//                              not here (see WorkspaceChatAppSchema).
//   channel='web'            → NO credentials. A panel-only agent
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

// An assistant's own Google Chat app: every assistant on the channel is its own
// app in its own Google Cloud project, as every assistant on Discord is its own
// bot. Every field is optional here and checked
// by the adapter's start(): a requirement at this level would fail the whole
// file, and with it the panel-only maintainer and every reload.
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
  // Where the certificates Chat signs events with are fetched, and the base URL
  // of the Chat API replies are posted to. Absent, they are Google's. They exist
  // so a test can serve both endpoints itself; an address the adapter's
  // endpoint rule refuses keeps the app from being served.
  certificates_url: z.string().optional(),
  api_root: z.string().optional(),
});
export type WorkspaceChatAppConfig = z.infer<typeof WorkspaceChatAppSchema>;

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
    // acp` has no flag to pick one, so the mode IS the agent selector. It is
    // configurable because the health probe runs an assistant of its own: the
    // probe asks for a one-word answer, and the maintainer reasonably answers
    // with a paragraph.
    //
    // Defaulted to `cerase` rather than required, so a file without it keeps
    // loading. A mode the slot does not define is refused per agent, with the
    // modes the slot does offer in the message.
    mode: z.string().min(1).default(CERASE_SESSION_MODE),
    // The model this assistant runs on, as the `provider/model` pair opencode
    // names it (for example `cerase-litellm/core`), written by the
    // control-plane.
    //
    // A new session starts on the slot's configured default and needs nothing
    // from here. A RESUMED one does not: opencode restores a loaded session's
    // model from its last user message and keeps it for every later prompt, and
    // each new user message is stamped with it again. A session whose last user
    // message carries some other route therefore stays on that route for good,
    // and this is the value the bridge sets it back to after the load.
    //
    // Optional, so a file written without it keeps loading; without it a
    // resumed session keeps the model opencode restored.
    model: z.string().min(1).optional(),
    workspace_chat: WorkspaceChatAppSchema.optional(),
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
  // How long the ACP stream may say NOTHING before the child counts as hung.
  // This is what the watchdog measures, and it is not the same question as how
  // long a turn may take: a child emitting thought chunks is alive whatever the
  // clock says, and a child that has emitted nothing for three minutes is not
  // going to start.
  //
  // Optional because a file written before this existed must keep loading, and
  // the default belongs in one place (SessionManager) rather than in every
  // rendered config.
  turn_silence_seconds: z.number().int().positive().optional(),
  // The ceiling a turn cannot cross even while it keeps streaming. It exists
  // for the turn that never stops rather than for the one that is slow, so it
  // is minutes and not seconds, and reaching it produces a reply that says so.
  //
  // A mail assistant and one carrying a project do not want the same value,
  // which is why this is configuration and not a constant.
  turn_ceiling_minutes: z.number().int().positive().optional(),
});

const BridgeConfigSchema = z
  .object({
    // Zero agents is a valid state: the bridge starts idle and the reload
    // brings agents in as they are added. The appliance renders `agents: []`
    // when it has no agents to render (RegenAgentsYaml), and the bridge must
    // load it without crash-looping.
    agents: z.array(AgentSchema),
    session: SessionSchema,
    // The organisation's language, for the notices the bridge writes by itself
    // when a person's own messages have not said which language they use.
    locale: z.enum(["it", "en", "es", "fr"]).optional(),
    // The console's file-size limit, in MB. An inbound attachment over it is
    // refused before it is downloaded, and an outbound one is read up to it.
    // Optional: a control-plane that does not write it leaves the fallback.
    max_file_mb: z.number().int().positive().optional(),
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

// Replaces every `${env:VAR}` token in `raw` with `env[VAR]`. Throws when a
// referenced variable is absent from `env` or empty, so a missing token
// surfaces at config-load time, not at first message dispatch.
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
  // Set on every load, the boot one and each reload, so the limit the bridge
  // holds attachments to is always the console's last word.
  setConsoleFileLimitMb(result.data.max_file_mb);
  return result.data;
}

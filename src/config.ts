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

const AgentSchema = z.object({
  id: AgentIdSchema,
  bot_token: z.string().min(1, "bot_token cannot be empty"),
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
export function resolveEnvSubstitutions(
  raw: string,
  env: Record<string, string | undefined>,
): string {
  return raw.replace(/\$\{env:([A-Z0-9_]+)\}/g, (_, name: string) => {
    const value = env[name];
    if (value === undefined || value === "") {
      throw new Error(
        `config references \${env:${name}} but the environment variable is not set`,
      );
    }
    return value;
  });
}

// Loads `agents.yaml` from `path`, resolves env substitutions against
// `env` (defaults to `process.env`), parses YAML, validates with zod.
// Throws with operator-readable error messages on any failure mode.
export function loadConfig(
  path: string,
  env: Record<string, string | undefined> = process.env,
): BridgeConfig {
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
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`agents.yaml schema validation failed:\n${issues}`);
  }
  return result.data;
}

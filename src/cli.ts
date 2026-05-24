// Standalone debug CLI. Exercises the bridge's core pipeline
// (allowlist → turn-meta → session-manager) for a single round-trip,
// streaming the agent's reply to stdout as ACP `agent_message_chunk`
// updates arrive. No Discord, no compose, no test-injection HTTP
// server — useful for isolated debug against the fake-acp-child or
// against a real `opencode acp`.
//
// The Dispatcher's StreamBuffer + SendQueue are intentionally bypassed
// here: those exist to chunk + rate-limit for Discord's 2000-char DM
// limit; the CLI's "channel" is just stdout where raw token streaming
// is what the developer wants.

import { loadConfig } from "./config.js";
import { isAllowed } from "./allowlist.js";
import { SessionManager } from "./session-manager.js";
import { TurnMetaTracker } from "./turn-meta.js";
import { pickRefusalMessage } from "./dispatcher.js";

export interface CliIO {
  stdoutWrite: (chunk: string) => void;
  stderrWrite: (chunk: string) => void;
}

const defaultIO: CliIO = {
  stdoutWrite: (s) => process.stdout.write(s),
  stderrWrite: (s) => process.stderr.write(s),
};

const USAGE = `Usage: cerase-acp-cli <subcommand> [options]

Subcommands:
  prompt --config <path> --agent <id> --user <discord-id> "<text>"
                              Run one round-trip through the bridge
                              pipeline (allowlist → turn-meta →
                              session-manager) and stream the reply to
                              stdout.

Options for \`prompt\`:
  --config <path>     Path to agents.yaml.   (required)
  --agent  <id>       Agent id in agents.yaml. (required)
  --user   <id>       Discord user id (for allowlist + turn-meta keying).
                                              (required)
  <text>              The prompt text (positional, required).

  --help, -h          Print this message and exit 0.

Exit codes:
  0  success (including the polite-refusal path for unauthorised users)
  1  config / argv / wiring / ACP failure
`;

interface PromptArgs {
  configPath: string;
  agentId: string;
  userId: string;
  text: string;
}

function parsePromptArgs(argv: string[]): PromptArgs | { error: string } {
  let configPath = "";
  let agentId = "";
  let userId = "";
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config") {
      const v = argv[++i];
      if (!v) return { error: "--config requires a value" };
      configPath = v;
    } else if (a === "--agent") {
      const v = argv[++i];
      if (!v) return { error: "--agent requires a value" };
      agentId = v;
    } else if (a === "--user") {
      const v = argv[++i];
      if (!v) return { error: "--user requires a value" };
      userId = v;
    } else if (a.startsWith("--")) {
      return { error: `unknown flag: ${a}` };
    } else {
      positionals.push(a);
    }
  }
  if (!configPath) return { error: "--config <path> is required" };
  if (!agentId) return { error: "--agent <id> is required" };
  if (!userId) return { error: "--user <discord-id> is required" };
  if (positionals.length === 0) return { error: "prompt text (positional) is required" };
  return { configPath, agentId, userId, text: positionals.join(" ") };
}

async function runPrompt(args: PromptArgs, io: CliIO): Promise<number> {
  let cfg;
  try {
    cfg = loadConfig(args.configPath);
  } catch (err) {
    io.stderrWrite(`config error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  // Validate agent exists before spawning anything.
  const agent = cfg.agents.find((a) => a.id === args.agentId);
  if (!agent) {
    io.stderrWrite(`unknown agent id "${args.agentId}" — known: ${cfg.agents.map((a) => a.id).join(", ")}\n`);
    return 1;
  }

  // Allowlist gate. Refusal is a valid response, not an error — exit 0.
  if (!isAllowed(cfg, args.agentId, args.userId)) {
    io.stdoutWrite(pickRefusalMessage(args.text) + "\n");
    return 0;
  }

  const mgr = new SessionManager(cfg);
  const turnMeta = new TurnMetaTracker();
  const prefix = turnMeta.prefix(args.agentId, args.userId, args.text);
  try {
    await mgr.prompt(args.agentId, args.userId, prefix + args.text, (update) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        io.stdoutWrite(update.content.text);
      }
    });
    io.stdoutWrite("\n");
    return 0;
  } catch (err) {
    io.stderrWrite(`\nACP error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    await mgr.shutdown();
  }
}

export async function runCli(argv: string[], io: CliIO = defaultIO): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    io.stdoutWrite(USAGE);
    return 0;
  }
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "prompt") {
    if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
      io.stdoutWrite(USAGE);
      return 0;
    }
    const parsed = parsePromptArgs(rest);
    if ("error" in parsed) {
      io.stderrWrite(`${parsed.error}\n\n${USAGE}`);
      return 1;
    }
    return runPrompt(parsed, io);
  }
  io.stderrWrite(`unknown subcommand: ${sub}\n\n${USAGE}`);
  return 1;
}

// Entry point when invoked as `node dist/cli.js …`. The export above
// is also imported directly by `src/cli.test.ts` so the unit tests run
// in-process without spawning a child.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      // Defence in depth: any uncaught rejection in runCli surfaces
      // here with a structured exit. runCli itself should not throw.
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    },
  );
}

// Standalone debug CLI. Two subcommands:
//
//   prompt --config X --agent Y --user Z "<text>"
//     One-shot: spawn → prompt → stream reply → shutdown.
//
//   repl   --config X --agent Y --user Z
//     Stay alive across N turns. Single SessionManager +
//     TurnMetaTracker + opencode-acp child kept alive for the
//     duration of the REPL, mirroring the daemon's `(agent, user)`
//     lifecycle. Empty line / EOF / SIGINT → shutdown.
//
// Why repl runs in-process and not as a spawn per turn: the daemon keeps one
// long-lived ACP child per `(agent, user)` pair across messages, which is
// where conversation continuity comes from. The CLI's `repl` keeps the same
// lifecycle so it shows the same problems; a spawn per turn would test a
// scenario where each turn is a fresh session.

import * as readline from "node:readline";
import { isAllowed } from "./allowlist.js";
import { type AgentConfig, type BridgeConfig, loadConfig } from "./config.js";
import { pickRefusalMessage } from "./dispatcher.js";
import { SessionManager, type TurnTelemetry } from "./session-manager.js";
import { TurnMetaTracker } from "./turn-meta.js";

export interface CliIO {
  stdoutWrite: (chunk: string) => void;
  stderrWrite: (chunk: string) => void;
  /**
   * Read one line of input for the REPL. Default uses node:readline on
   * process.stdin. Tests inject a custom function that returns a
   * pre-canned sequence of lines.
   */
  readLine?: () => Promise<string | null>;
}

const defaultIO: CliIO = {
  stdoutWrite: (s) => process.stdout.write(s),
  stderrWrite: (s) => process.stderr.write(s),
};

const USAGE = `Usage: cerase-acp-cli <subcommand> [options]

Subcommands:
  prompt --config <path> --agent <id> --user <id> "<text>"
                              One-shot round-trip through the bridge
                              pipeline; spawn → prompt → stream reply
                              → shutdown.

  repl   --config <path> --agent <id> --user <id>
                              Interactive REPL. Same agent/user across
                              N turns — single ACP child kept alive,
                              mirroring the production daemon's
                              lifecycle. Empty line / Ctrl-D ends.

Common flags:
  --config <path>     Path to agents.yaml.   (required)
  --agent  <id>       Agent id in agents.yaml. (required)
  --user   <id>       Discord user id (allowlist + turn-meta key).
                                              (required)

  --help, -h          Print this message and exit 0.

Exit codes:
  0  success (including the polite-refusal path for unauthorised users)
  1  config / argv / wiring / ACP failure
`;

interface CommonArgs {
  configPath: string;
  agentId: string;
  userId: string;
}

interface PromptArgs extends CommonArgs {
  text: string;
}

function parseCommonArgs(argv: string[]): CommonArgs | { error: string } {
  let configPath = "";
  let agentId = "";
  let userId = "";
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
    }
  }
  if (!configPath) return { error: "--config <path> is required" };
  if (!agentId) return { error: "--agent <id> is required" };
  if (!userId) return { error: "--user <discord-id> is required" };
  return { configPath, agentId, userId };
}

function parsePromptArgs(argv: string[]): PromptArgs | { error: string } {
  const positionals: string[] = [];
  const filtered: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config" || a === "--agent" || a === "--user") {
      filtered.push(a);
      const v = argv[++i];
      if (v !== undefined) filtered.push(v);
    } else if (a.startsWith("--")) {
      return { error: `unknown flag: ${a}` };
    } else {
      positionals.push(a);
    }
  }
  const common = parseCommonArgs(filtered);
  if ("error" in common) return common;
  if (positionals.length === 0) return { error: "prompt text (positional) is required" };
  return { ...common, text: positionals.join(" ") };
}

/**
 * Load config + resolve agent + allowlist gate. Returns the validated
 * triple, OR an early-exit signal (refusal text already printed to
 * stdout, or fatal error printed to stderr). Shared by prompt + repl.
 */
function loadAndValidate(
  args: CommonArgs,
  io: CliIO,
  refusalProbeText: string | null,
): { cfg: BridgeConfig; agent: AgentConfig } | { exitCode: number } {
  let cfg: BridgeConfig;
  try {
    cfg = loadConfig(args.configPath);
  } catch (err) {
    io.stderrWrite(`config error: ${err instanceof Error ? err.message : String(err)}\n`);
    return { exitCode: 1 };
  }
  const agent = cfg.agents.find((a) => a.id === args.agentId);
  if (!agent) {
    io.stderrWrite(`unknown agent id "${args.agentId}" — known: ${cfg.agents.map((a) => a.id).join(", ")}\n`);
    return { exitCode: 1 };
  }
  if (!isAllowed(cfg, args.agentId, args.userId)) {
    // Refusal text language is keyed off the probe text passed in
    // (one-shot: the prompt text; repl: none, so the default language).
    // Caller exits 0 — refusal is a valid response.
    io.stdoutWrite(`${pickRefusalMessage(refusalProbeText ?? "")}\n`);
    return { exitCode: 0 };
  }
  return { cfg, agent };
}

/**
 * Run one prompt round-trip against the given (already-instantiated)
 * SessionManager + TurnMetaTracker. Streams `agent_thought_chunk`
 * dim+italic to stderr and `agent_message_chunk` plain to stdout.
 * When thought chunks arrive and no message chunk does, says so on
 * stdout, so a reply that was all reasoning does not look empty.
 *
 * Returns 0 on success, 1 on ACP error. Does NOT shutdown the
 * manager — that's the caller's responsibility.
 */
async function runOneTurn(
  mgr: SessionManager,
  tracker: TurnMetaTracker,
  agentId: string,
  userId: string,
  text: string,
  io: CliIO,
  telemetrySink?: { last?: TurnTelemetry },
): Promise<number> {
  const DIM_IT = "\x1b[2;3m";
  const RESET = "\x1b[0m";
  let messageBytes = 0;
  let thoughtBytes = 0;
  let inThoughtBlock = false;
  const beginThoughtIfNeeded = () => {
    if (!inThoughtBlock) {
      inThoughtBlock = true;
      io.stderrWrite(`${DIM_IT}thinking: `);
    }
  };
  const endThoughtIfNeeded = () => {
    if (inThoughtBlock) {
      inThoughtBlock = false;
      io.stderrWrite(`${RESET}\n`);
    }
  };

  const prefix = tracker.prefix(agentId, userId, text);
  try {
    await mgr.prompt(agentId, userId, prefix + text, (update) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        endThoughtIfNeeded();
        io.stdoutWrite(update.content.text);
        messageBytes += update.content.text.length;
      } else if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") {
        beginThoughtIfNeeded();
        io.stderrWrite(update.content.text);
        thoughtBytes += update.content.text.length;
      }
    });
    endThoughtIfNeeded();
    if (messageBytes === 0 && thoughtBytes > 0) {
      io.stdoutWrite("(no direct reply from the agent — only the thought above)");
    }
    io.stdoutWrite("\n");
    // Say once per turn, on stderr, when text or reasoning the ACP stream
    // missed was recovered from opencode's stored message after the turn.
    const last = telemetrySink?.last;
    if (last && (last.reconciledTextBytes > 0 || last.reconciledReasoningBytes > 0)) {
      const DIM = "\x1b[2m";
      io.stderrWrite(
        `${DIM}[recovered ${last.reconciledTextBytes}b text + ` +
          `${last.reconciledReasoningBytes}b thought from audit log]${RESET}\n`,
      );
    }
    return 0;
  } catch (err) {
    endThoughtIfNeeded();
    io.stderrWrite(`\nACP error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function runPrompt(args: PromptArgs, io: CliIO): Promise<number> {
  const validated = loadAndValidate(args, io, args.text);
  if ("exitCode" in validated) return validated.exitCode;
  const telemetrySink: { last?: TurnTelemetry } = {};
  const mgr = new SessionManager(validated.cfg, undefined, {
    onTelemetry: (t) => (telemetrySink.last = t),
  });
  const tracker = new TurnMetaTracker();
  try {
    return await runOneTurn(mgr, tracker, args.agentId, args.userId, args.text, io, telemetrySink);
  } finally {
    await mgr.shutdown();
  }
}

/** Default REPL reader: one line per call from process.stdin via node:readline. */
function makeStdinReadLine(): () => Promise<string | null> {
  const rl = readline.createInterface({ input: process.stdin });
  const buffer: string[] = [];
  let waitResolve: ((v: string | null) => void) | null = null;
  let closed = false;
  rl.on("line", (line) => {
    if (waitResolve) {
      const r = waitResolve;
      waitResolve = null;
      r(line);
    } else {
      buffer.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    if (waitResolve) {
      const r = waitResolve;
      waitResolve = null;
      r(null);
    }
  });
  return () => {
    return new Promise((resolve) => {
      if (buffer.length > 0) return resolve(buffer.shift()!);
      if (closed) return resolve(null);
      waitResolve = resolve;
    });
  };
}

async function runRepl(args: CommonArgs, io: CliIO): Promise<number> {
  const validated = loadAndValidate(args, io, null);
  if ("exitCode" in validated) return validated.exitCode;

  // An unauthorised user never reaches the loop: loadAndValidate above has
  // already printed the refusal. Authorised path: one SessionManager and
  // TurnMetaTracker across all turns of this REPL.
  const telemetrySink: { last?: TurnTelemetry } = {};
  const mgr = new SessionManager(validated.cfg, undefined, {
    onTelemetry: (t) => (telemetrySink.last = t),
  });
  const tracker = new TurnMetaTracker();
  const readLine = io.readLine ?? makeStdinReadLine();
  io.stderrWrite(`cerase-acp REPL — agent=${args.agentId} user=${args.userId}. Empty line or Ctrl-D to exit.\n`);
  try {
    while (true) {
      io.stderrWrite("> ");
      const line = await readLine();
      if (line === null || line.length === 0) {
        io.stderrWrite("\n");
        return 0;
      }
      const rc = await runOneTurn(mgr, tracker, args.agentId, args.userId, line, io, telemetrySink);
      // A failing turn, a failed spawn included, does not end the REPL: the
      // error is printed and the user can try another line.
      if (rc !== 0) {
        io.stderrWrite("(turn failed — try another line, or empty line to exit)\n");
      }
    }
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
  if (sub === "repl") {
    if (rest[0] === "--help" || rest[0] === "-h") {
      io.stdoutWrite(USAGE);
      return 0;
    }
    const parsed = parseCommonArgs(rest);
    if ("error" in parsed) {
      io.stderrWrite(`${parsed.error}\n\n${USAGE}`);
      return 1;
    }
    return runRepl(parsed, io);
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
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    },
  );
}

// Shared logger factory. All cerase-acp loggers write to stderr (fd 2)
// so stdout stays clean for:
//   - the ACP NDJSON stream when this process is an ACP child (reserved)
//   - the agent's reply stream in CLI mode (so `./cli.sh prompt … | jq`
//     and similar pipelines don't ingest pino log lines)
//
// Mixing logs into stdout caused a visible bug during M9 manual smoke:
// the auto-cancel warning issued when an in-DM permission request fired
// landed inline with the streamed LLM reply.

import pino from "pino";

const LEVEL = process.env.CERASE_ACP_LOG_LEVEL ?? "info";

export function makeLogger(name: string): pino.Logger {
  return pino({ name, level: LEVEL }, pino.destination(2));
}

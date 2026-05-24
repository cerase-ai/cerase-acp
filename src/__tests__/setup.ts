// Vitest setup file — runs before each test module loads. Silences the
// pino loggers used by src/* so test output stays focused on assertions
// and failure stack traces.
process.env.CERASE_ACP_LOG_LEVEL ??= "silent";

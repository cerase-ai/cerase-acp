// The console's file-size limit: the largest file that may enter or leave an
// assistant's workspace through the bridge.
//
// The control-plane writes it into agents.yaml as `max_file_mb`, and every load
// of that file sets it here (see `loadConfig`), so a limit changed in the
// console reaches the bridge on the next reload. A file without the key, from a
// control-plane that did not write it, falls back to CERASE_MAX_ATTACHMENT_MB
// and then to 64, the ceiling every layer of the platform is built to carry.

const FALLBACK_MB = Number(process.env.CERASE_MAX_ATTACHMENT_MB) || 64;

let consoleMb: number | undefined;

/** Set from agents.yaml's `max_file_mb`; undefined restores the fallback. */
export function setConsoleFileLimitMb(mb: number | undefined): void {
  consoleMb = mb !== undefined && Number.isInteger(mb) && mb > 0 ? mb : undefined;
}

/** The limit in MB. */
export function fileLimitMb(): number {
  return consoleMb ?? FALLBACK_MB;
}

/** The limit in bytes. */
export function fileLimitBytes(): number {
  return fileLimitMb() * 1024 * 1024;
}

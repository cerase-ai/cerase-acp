// The hosts a person names in a message, handed to the control-plane before the
// turn runs so the assistant can open the page they asked about.
//
// Extraction is deliberately conservative: a false host would grant the
// assistant a page nobody asked for, while a missed host only means the
// assistant asks the person again. So an email address is a mailbox, not a
// page, and a file name is a file, not a host.

import { controlPlaneHeaders } from "./control-plane-headers.js";

export interface ReachableHostsOptions {
  controlPlaneUrl: string;
  internalSecret: string;
  bridgeSecret: string;
  fetchImpl?: typeof fetch;
}

// A document extension says the person is naming a file they already have, not
// a page to open. A URL that carries one still has its host taken: there the
// extension is part of the path, not of the host.
const DOCUMENT_EXTENSIONS = new Set([
  "pdf",
  "docx",
  "doc",
  "xlsx",
  "xls",
  "pptx",
  "ppt",
  "csv",
  "txt",
  "md",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "zip",
  "mp3",
  "mp4",
  "wav",
  "html",
  "htm",
  "json",
  "xml",
]);

// A URL with its scheme, or a bare host with an optional port and path. The
// lookbehind keeps the domain of an email address out.
const CANDIDATE =
  /https?:\/\/[^\s<>"']+|(?<![\w@.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s<>"']*)?(?![\w-])/gi;

const MAX_HOSTS = 20;
const TIMEOUT_MS = 3_000;

/**
 * The hosts named in `text`, lower-cased, deduplicated, and in the order they
 * appear. At most twenty, so a long message cannot turn into a long grant.
 */
export function hostsNamedIn(text: string): string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(CANDIDATE)) {
    const candidate = match[0].replace(/[.,;:!?)\]}]+$/, "");
    let host: string | undefined;
    if (/^https?:\/\//i.test(candidate)) {
      try {
        host = new URL(candidate).hostname.toLowerCase();
      } catch {
        continue;
      }
    } else {
      const authority = candidate.split("/")[0] ?? "";
      host = authority.split(":")[0]?.toLowerCase();
      if (!host) continue;
      const lastDot = host.lastIndexOf(".");
      const extension = lastDot === -1 ? "" : host.slice(lastDot + 1);
      if (DOCUMENT_EXTENSIONS.has(extension)) continue;
    }
    if (!host || seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
    if (hosts.length === MAX_HOSTS) break;
  }
  return hosts;
}

/**
 * Hand the hosts a person named to the control-plane, so the assistant can
 * open them during the turn. Never throws: a control-plane that cannot hear
 * this must not cost the person their turn.
 */
export async function grantReachableHosts(
  agentId: string,
  hosts: string[],
  opts: ReachableHostsOptions,
): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  const url = `${opts.controlPlaneUrl.replace(/\/$/, "")}/api/internal/agents/${encodeURIComponent(agentId)}/reachable-hosts`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    await f(url, {
      method: "POST",
      headers: {
        ...controlPlaneHeaders(opts),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ hosts }),
      signal: controller.signal,
    });
  } catch {
    // The turn goes ahead without the grant: a control-plane fault must not
    // block chat, and the person's words still reach the assistant.
  } finally {
    clearTimeout(timer);
  }
}

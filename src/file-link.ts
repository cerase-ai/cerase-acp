// Ask the control-plane for a link to a workspace file.
//
// A file the assistant attaches is uploaded into the chat where the channel
// can carry it. Where it cannot -- a channel with no upload at all, a document
// past Telegram's 50 MB, a Slack token without `files:write` -- the file still
// has to reach the person, so the bridge asks the control-plane to serve it
// from its own storage and writes that address into the chat. Unlike the
// summary and outcome reports this is not best-effort: without the link there
// is nothing to send, so a refusal is thrown and the caller tells the person
// the attachment did not arrive.
//
// The route is internal, so the request carries the control-plane bearer, and
// the answer is reshaped into the camelCase this codebase uses.

/** A served file: where it is, what it is called, and when the address stops working. */
export interface FileLink {
  url: string;
  name: string;
  expiresAt: string;
  sizeBytes: number;
}

export interface FileLinkOptions {
  controlPlaneUrl: string;
  internalSecret: string;
  fetchImpl?: typeof fetch;
}

/** What the control-plane names a refused link request in its body. */
interface FileLinkRefusal {
  error?: unknown;
}

/** What the control-plane answers when it accepts the request. */
interface FileLinkAnswer {
  url: string;
  expires_at: string;
  name: string;
  size_bytes: number;
}

/**
 * POST the agent and the workspace-relative path to the internal file-link
 * route, and resolve with the served file.
 * Rejects on a non-2xx, naming the status and the refusal, and on a network
 * error.
 */
export async function requestFileLink(agentId: string, path: string, opts: FileLinkOptions): Promise<FileLink> {
  const f = opts.fetchImpl ?? fetch;
  const url = `${opts.controlPlaneUrl.replace(/\/$/, "")}/api/internal/file-links`;
  const resp = await f(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.internalSecret}`,
    },
    body: JSON.stringify({ agent_id: agentId, path }),
  });
  if (!resp.ok) {
    // The refusal says why the path cannot be served -- outside the workspace,
    // missing, too large -- and that sentence is the one a log reader needs.
    let refusal = "";
    try {
      const body = (await resp.json()) as FileLinkRefusal;
      if (typeof body.error === "string") refusal = body.error;
    } catch {
      // A refusal without a readable body is still a refusal, and the status
      // alone names it.
    }
    throw new Error(`file-link request failed: ${resp.status}${refusal ? ` — ${refusal}` : ""}`);
  }
  const answer = (await resp.json()) as FileLinkAnswer;
  return {
    url: answer.url,
    name: answer.name,
    expiresAt: answer.expires_at,
    sizeBytes: answer.size_bytes,
  };
}

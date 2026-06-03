// HITL-3/4 — acp injects the server-minted approval link into the
// agent's outgoing message via the {{APPROVAL_LINK}} placeholder.
//
// The link is minted by the control-plane and fetched here over the
// internal channel — it NEVER enters the agent/LLM context (the agent
// is exactly what we're gating, so if it held the token it could
// self-approve). The chat carries only a link, no buttons.

const PLACEHOLDER = "{{APPROVAL_LINK}}";

/**
 * Apply the approval link to an outgoing message.
 *  - link present + placeholder present → replace every placeholder.
 *  - link present + no placeholder       → append the link at the end.
 *  - link absent (no pending approval)    → strip the placeholder so the
 *    raw `{{APPROVAL_LINK}}` is never shown to the user.
 */
export function applyApprovalLink(text: string, link: string | null): string {
  const hasPlaceholder = text.includes(PLACEHOLDER);

  if (!link) {
    return hasPlaceholder ? text.split(PLACEHOLDER).join("").trimEnd() : text;
  }
  if (hasPlaceholder) {
    return text.split(PLACEHOLDER).join(link);
  }
  return `${text.trimEnd()}\n\n👉 ${link}`;
}

/** True when a message needs the approval link wired in. */
export function needsApprovalLink(text: string): boolean {
  return text.includes(PLACEHOLDER);
}

export interface PendingLinkOptions {
  controlPlaneUrl: string;
  internalSecret: string;
  fetchImpl?: typeof fetch;
}

/**
 * Fetch the signed link for an agent's latest pending approval from the
 * control-plane, or null when there is none / on any failure.
 */
export async function fetchPendingApprovalLink(
  agentId: string,
  opts: PendingLinkOptions,
): Promise<string | null> {
  const f = opts.fetchImpl ?? fetch;
  const url =
    `${opts.controlPlaneUrl.replace(/\/$/, "")}/api/internal/approval-pending-link` +
    `?agent_id=${encodeURIComponent(agentId)}`;
  try {
    const resp = await f(url, {
      headers: { Authorization: `Bearer ${opts.internalSecret}` },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { approval_link?: string | null };
    return data.approval_link ?? null;
  } catch {
    return null;
  }
}

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
export async function fetchPendingApprovalLink(agentId: string, opts: PendingLinkOptions): Promise<string | null> {
  const f = opts.fetchImpl ?? fetch;
  const url =
    `${opts.controlPlaneUrl.replace(/\/$/, "")}/api/internal/approval-pending-link` +
    `?agent_id=${encodeURIComponent(agentId)}`;
  // M-ACP-2: fetch FAILURE is not the same as "no pending approval" —
  // returning null for both made the caller silently strip the
  // placeholder and dead-end the HITL flow when the control-plane was
  // merely unreachable. Failure now THROWS; the caller substitutes an
  // explanatory fallback.
  const resp = await f(url, {
    headers: { Authorization: `Bearer ${opts.internalSecret}` },
  });
  if (!resp.ok) {
    throw new Error(`approval-pending-link returned HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as { approval_link?: string | null };
  return data.approval_link ?? null;
}

/**
 * M-ACP-2 — replace the placeholder with an explanatory note when the
 * link could not be fetched: the user still learns WHERE to approve.
 */
export function applyApprovalLinkFallback(text: string): string {
  if (!text.includes(PLACEHOLDER)) return text;
  return text
    .split(PLACEHOLDER)
    .join(
      "⚠️ link di approvazione momentaneamente non disponibile — apri la coda Approvazioni nel pannello admin / approval link temporarily unavailable — open the Approvals queue in the admin panel",
    );
}

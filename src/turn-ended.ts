// The control-plane sends the person one approval link for the turn's actions
// once it hears the turn ended. So the bridge tells it, at the end of every
// turn it runs, which assistant and which person the turn was for.

export interface TurnEndedOptions {
  controlPlaneUrl: string;
  internalSecret: string;
  fetchImpl?: typeof fetch;
}

/**
 * Tell the control-plane a turn ended, and for whom.
 *
 * THROWS on anything that is not a 2xx: the caller reports the end of a turn
 * best-effort and must not let a control-plane that cannot hear it change what
 * the person sees or hold up the next turn.
 */
export async function postTurnEnded(
  agentId: string,
  identity: { platform?: string; platformUserId?: string },
  opts: TurnEndedOptions,
): Promise<void> {
  const body: { platform?: string; platform_user_id?: string } = {};
  if (identity.platform !== undefined) body.platform = identity.platform;
  if (identity.platformUserId !== undefined) body.platform_user_id = identity.platformUserId;

  const url = `${opts.controlPlaneUrl.replace(/\/$/, "")}/api/internal/turn-ended/${encodeURIComponent(agentId)}`;
  const f = opts.fetchImpl ?? fetch;
  const resp = await f(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.internalSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`turn-ended: HTTP ${resp.status}`);
  }
}

// Report the outcome of a scheduled message's turn to the control-plane.
//
// The turn behind an inject is detached: its caller was answered 202 before it
// started, so it learns how the turn ended through this call rather than the
// response. Best-effort like the summary capture: a reporting failure must
// never affect the turn, so this resolves to a boolean and never throws.

/** What the control-plane records for the turn named by an `outcome_ref`. */
export type InjectOutcome = { ok: boolean; error?: string; notice?: string };

export interface InjectOutcomeOptions {
  controlPlaneUrl: string;
  internalSecret: string;
  fetchImpl?: typeof fetch;
}

/**
 * POST the outcome to the control-plane.
 * Resolves true on a 2xx, false on a non-ok response or a network error.
 */
export async function postInjectOutcome(
  ref: string,
  outcome: InjectOutcome,
  opts: InjectOutcomeOptions,
): Promise<boolean> {
  const f = opts.fetchImpl ?? fetch;
  const url = `${opts.controlPlaneUrl.replace(/\/$/, "")}/api/internal/inject-outcome`;
  const body: Record<string, unknown> = { ref, ok: outcome.ok };
  if (outcome.error !== undefined) body.error = outcome.error.slice(0, 1000);
  if (outcome.notice !== undefined) body.notice = outcome.notice.slice(0, 1000);

  try {
    const resp = await f(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.internalSecret}`,
      },
      body: JSON.stringify(body),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

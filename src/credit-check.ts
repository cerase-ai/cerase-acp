// Proactive out-of-credits check.
//
// opencode swallows the LiteLLM 429/402 that the credit gate raises, so the
// dispatcher's REACTIVE credit copy never fires — the turn HANGS until the
// watchdog. The bridge instead asks the control-plane BEFORE spawning /
// prompting whether the tenant still has credits, and short-circuits with the
// no-credits copy when it doesn't.
//
// Backs QUOTA-1-D's `POST /api/internal/credit-check/{agent}` (the same
// endpoint the LiteLLM cerase_credit_gate hook calls) over the same internal
// bearer the bridge already uses for session-summary — no new secret. The
// controller answers 402 when the tenant is below the credit safety buffer,
// 200 (proceed) otherwise.
//
// Contract with the dispatcher: this either RESOLVES `{exhausted}` (402 →
// true, 200 → false) or THROWS. It must NOT swallow errors — the dispatcher
// fails OPEN on a throw (a control-plane glitch must never block chat).

export interface CreditCheckOptions {
  controlPlaneUrl: string;
  internalSecret: string;
  fetchImpl?: typeof fetch;
}

/**
 * Ask the control-plane whether the agent's tenant is out of credits.
 *  - HTTP 402 (below the safety buffer) → `{ exhausted: true }`
 *  - HTTP 200 (proceed)                 → `{ exhausted: false }`
 *  - anything else (401/403/404/5xx) or a network error → THROWS, so the
 *    dispatcher fails open and proceeds with the turn.
 */
export async function checkTenantCredit(agentId: string, opts: CreditCheckOptions): Promise<{ exhausted: boolean }> {
  const f = opts.fetchImpl ?? fetch;
  const url = `${opts.controlPlaneUrl.replace(/\/$/, "")}/api/internal/credit-check/${encodeURIComponent(agentId)}`;

  const resp = await f(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.internalSecret}` },
  });

  // 402 Payment Required = tenant below the credit safety buffer (exhausted).
  if (resp.status === 402) return { exhausted: true };
  // 2xx = proceed.
  if (resp.ok) return { exhausted: false };
  // Any other status is an error the caller must fail OPEN on (never block
  // chat on a control-plane fault) — signal it by throwing.
  throw new Error(`credit-check returned HTTP ${resp.status}`);
}

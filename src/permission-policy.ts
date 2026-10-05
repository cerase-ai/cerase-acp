// Permission-policy decisions for DM-only agents.
//
// A permission request is granted whenever an allow option is offered. The
// model reads a cancelled request ("user rejected permission") as the user
// changing their mind, emits no follow-up text, and the turn goes silent. A
// DM is a trust context where the user has approved tool use by starting the
// conversation; the per-tool permission UI is for IDE clients.
//
// The container sandbox, the non-root `agent` uid and the read-only config
// mount remain the real security boundary.
// Anything the model can do inside that sandbox is by design
// reachable from a DM prompt — that's the whole point.

import type * as acp from "@agentclientprotocol/sdk";

/**
 * Decide how to respond to an opencode permission request in
 * DM-only mode. Preference order:
 *
 *   1. `allow_always` — opencode caches the decision for the
 *      remainder of the session so subsequent identical tool
 *      calls don't re-prompt. Saves round-trips.
 *   2. `allow_once` — fallback when allow_always isn't offered.
 *   3. `cancelled` — defensive escape. Only fires if opencode
 *      stops offering allow_* options (e.g. a future config
 *      tightens to deny-only). The caller logs it at info, as it
 *      logs every outcome.
 *
 * Pure function — no logging here; the caller logs the chosen
 * outcome with enough context (agentId, userId) for forensic
 * grep'ing.
 */
export function decidePermissionOutcome(request: acp.RequestPermissionRequest): acp.RequestPermissionOutcome {
  const opts = request.options ?? [];
  const pick = opts.find((o) => o.kind === "allow_always") ?? opts.find((o) => o.kind === "allow_once");
  if (!pick) return { outcome: "cancelled" };
  return { outcome: "selected", optionId: pick.optionId };
}

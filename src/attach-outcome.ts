// What became of each file the assistant asked the bridge to attach, kept for
// the length of one turn.
//
// The upload runs in the send path, after the model has stopped writing: it
// composes its closing sentence while the file is still on the other side of a
// `docker exec`, so it cannot see its own outcome and has no reason to doubt
// it. A turn that delivered nothing therefore went out saying the work was
// done, with the platform's own failure notice two lines above it.
//
// This is what lets the dispatcher close a turn on what happened rather than
// on what was intended: the send path records a failure as it happens, the
// dispatcher reads once at the end of the turn and clears.

/** One file the person was promised and did not get. */
export interface AttachFailure {
  /** The file as the reader would name it, never a workspace path. */
  fileName: string;
  /** Why it did not arrive, in the words a log reader needs. */
  reason: string;
}

const key = (agentId: string, userId: string) => `${agentId}:${userId}`;

export class AttachOutcomeTracker {
  private failures = new Map<string, AttachFailure[]>();

  /** Start of a turn: nothing an earlier one recorded belongs to this one. */
  begin(agentId: string, userId: string): void {
    this.failures.delete(key(agentId, userId));
  }

  record(agentId: string, userId: string, failure: AttachFailure): void {
    const k = key(agentId, userId);
    const list = this.failures.get(k) ?? [];
    list.push(failure);
    this.failures.set(k, list);
  }

  /** Everything recorded since `begin`, and forgets it. */
  take(agentId: string, userId: string): AttachFailure[] {
    const k = key(agentId, userId);
    const list = this.failures.get(k) ?? [];
    this.failures.delete(k);
    return list;
  }
}

/**
 * The follow-up prompt that tells the assistant what did not arrive.
 *
 * It is a second prompt on the same session because ACP carries one prompt in
 * flight per session: there is no way to hand a result to a model that is
 * still writing, so the earliest the assistant can be told is the moment its
 * turn ends. Written in English like every other block the bridge prepends,
 * and it names the files rather than the paths for the same reason the user
 * notices do.
 */
export function attachFailurePrompt(failures: AttachFailure[]): string {
  const lines = failures.map((f) => `- ${f.fileName}: ${f.reason}`).join("\n");
  return [
    "[attach_result: failed]",
    "The file(s) below did NOT reach the person you are writing to. The upload runs after you stop writing, so this is the first you can hear of it.",
    lines,
    "Correct the record now, in one short message in the language of the conversation: say the file did not arrive and withdraw any claim that the work was delivered. Do not claim delivery, and do not emit an attach marker in this message.",
  ].join("\n");
}

/** The turn's own result: it delivered less than it said it did. */
export function attachFailureError(failures: AttachFailure[]): Error {
  const names = failures.map((f) => f.fileName).join(", ");
  return new Error(`attachment(s) never reached the user: ${names}`);
}

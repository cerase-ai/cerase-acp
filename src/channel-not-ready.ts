// A chat client cannot carry a message yet because it has not logged in.
//
// Unlike a refusal, this condition passes on its own: the login under way
// finishes, the client gets its user, and the same request can be sent again.
// Only this exact string code is the condition; a numeric code or a different
// string means something else and is answered as an ordinary failure.

export const CHANNEL_NOT_READY_CODE = "channel_not_ready";

/** An error a caller can recognise as the channel not being ready yet. */
export function channelNotReady(message: string): Error {
  return Object.assign(new Error(message), { code: CHANNEL_NOT_READY_CODE });
}

/** Whether an error says the chat client has not logged in yet. */
export function isChannelNotReady(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as { code?: unknown }).code === CHANNEL_NOT_READY_CODE;
}

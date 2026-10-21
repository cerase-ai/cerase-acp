// Discord's 50278 «Cannot send messages to this user», HTTP 400.
//
// Discord refuses a DM with this code when the bot and the person share no
// server. Every later send to that person meets the same answer while that
// stays true, so it is final for the message: retrying it only spends the send
// queue's attempts, and posting the failure marker into the same DM meets the
// same refusal. The bridge keeps the reply instead and reports the condition
// once, until the bot can reach the person.
//
// Only a numeric code is this refusal. discord.js raises the code as a number;
// a string that merely looks like it belongs to something else, and treating
// it as a 50278 would silence retries of a failure that can pass.

export const NO_SHARED_SERVER_CODE = 50278;

/** Whether an error is Discord's 50278 «Cannot send messages to this user». */
export function isNoSharedServer(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as { code?: unknown }).code === NO_SHARED_SERVER_CODE;
}

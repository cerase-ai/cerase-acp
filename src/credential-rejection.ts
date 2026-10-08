// Which adapter start() failures mean the credential itself was refused.
//
// A channel adapter that fails to start is retried on a backoff, and that is
// the right answer for a condition which can stop being true on its own: a DNS
// blip, a gateway 5xx, a Cloudflare connect timeout. It is the wrong answer for
// a verdict the provider will keep returning. Discord answers "this is not a
// token" the same way on the first attempt and on the thirtieth, so retrying
// there keeps an assistant dead while every health signal reports work in
// progress.
//
// The test for putting a refusal in this table: no passage of time can change
// the answer, only a person editing agents.yaml or the Discord developer
// portal. Four discord.js refusals pass it.
//
//   TokenInvalid         the provider refused the token. login() raises it
//                        for an empty token and for a gateway lookup Discord
//                        answers with 401.
//   TokenMissing         a token the library needed and did not have. login()
//                        reports an empty token as TokenInvalid, so this code
//                        comes only from the library's shard-count helper,
//                        which the adapter does not call; it stays because it
//                        cannot mean anything but a missing credential.
//   AuthenticationFailed the gateway refused the token the client identified
//                        with: the verdict of TokenInvalid, met at the gateway
//                        rather than at the lookup before it.
//   DisallowedIntents    the application behind the token has not been
//                        granted a privileged intent it asks for. This bridge
//                        always requests MessageContent, which is privileged,
//                        so every bot whose portal switch was never ticked
//                        lands here and would otherwise retry for ever exactly
//                        like a bad token. The credential is intact; what it
//                        is allowed to do is not, and only a human in the
//                        portal changes that.
//
// How each arrives decides how it is matched. The two token codes come as
// DiscordjsErrors carrying the code, and are matched by it. The two gateway
// refusals carry no code: Discord closes the gateway (4004, 4014),
// @discordjs/ws turns the close into a bare Error whose message is all that
// names it, and login() rejects with that Error unwrapped. discord.js still
// lists a DisallowedIntents error code, but nothing in it raises one. A bare
// Error is therefore matched by its whole message, compared verbatim against
// the sentence the library writes, and reported under the name of the close
// code. A message that only resembles one stays retryable, because a near
// miss here would stop the retries of a failure that can pass.
//
// Left retryable, so the distinction stays honest: every transport error
// discord.js raises, and the gateway's other refusing closes, which arrive the
// same bare way. "Sharding is required" (4011) says the bot outgrew a single
// shard, which is a statement about scale rather than about the credential.
// "Used invalid intents" (4013), and ClientMissingIntents, which the client
// raises before it contacts Discord, both come from this repository's own
// intent bits, so they are a defect here rather than something an operator can
// fix, and config validation is where they belong.

/** A start() failure the channel provider will keep returning. */
export interface CredentialRejection {
  /**
   * The provider's own name for the refusal, verbatim, so a log line can be
   * searched for it: the library's error code, or the gateway close code's
   * name when the library raised the refusal without one.
   */
  code: string;
  /** The agents.yaml key holding the credential the provider refused. */
  credential: string;
  /** One line naming what a person has to do. Never carries the credential value. */
  detail: string;
}

/**
 * The refusals, keyed by the name they are reported under. A Map rather than
 * an object literal because the key comes off an error thrown by a library: an
 * object lookup would answer for `toString` and every other Object.prototype
 * member.
 */
const REJECTIONS = new Map<string, Omit<CredentialRejection, "code">>([
  [
    "TokenInvalid",
    {
      credential: "bot_token",
      detail:
        "Discord refused this bot token. Issue a new one in the Discord developer portal and set bot_token for this agent.",
    },
  ],
  [
    "TokenMissing",
    {
      credential: "bot_token",
      detail: "The Discord client had no bot token to log in with. Set bot_token for this agent.",
    },
  ],
  [
    "AuthenticationFailed",
    {
      credential: "bot_token",
      detail:
        "Discord refused this bot token. Issue a new one in the Discord developer portal and set bot_token for this agent.",
    },
  ],
  [
    "DisallowedIntents",
    {
      credential: "bot_token",
      detail:
        "The Discord application behind this bot token is not granted the Message Content intent. Enable it in the developer portal, under Bot and then Privileged Gateway Intents.",
    },
  ],
]);

/**
 * The gateway refusals @discordjs/ws raises as a bare Error, keyed by the
 * message it writes, verbatim, to the name of the close code behind it.
 */
const UNCODED_GATEWAY_REFUSALS = new Map<string, string>([
  ["Authentication failed", "AuthenticationFailed"],
  ["Used disallowed intents", "DisallowedIntents"],
]);

/** The name a start() failure is classified under, if it carries one. */
function refusalName(err: object): string | undefined {
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") return code;
  if (code === undefined && err instanceof Error) return UNCODED_GATEWAY_REFUSALS.get(err.message);
  return undefined;
}

/**
 * Classify a start() failure. Returns the rejection when the provider refused
 * the credential and retrying cannot change that, `undefined` for everything
 * else, which stays on the retry path.
 */
export function classifyCredentialRejection(err: unknown): CredentialRejection | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = refusalName(err);
  if (code === undefined) return undefined;
  const known = REJECTIONS.get(code);
  if (!known) return undefined;
  return { code, credential: known.credential, detail: known.detail };
}

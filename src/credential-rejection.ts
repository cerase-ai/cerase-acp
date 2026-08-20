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
// The test for putting a code in this table: no passage of time can change the
// answer, only a person editing agents.yaml or the Discord developer portal.
// Three discord.js codes pass it.
//
//   TokenInvalid       the provider refused the token at login. This is the
//                      one seen in production.
//   TokenMissing       the client was asked to use a token and had none. A
//                      retry re-asks with the same nothing.
//   DisallowedIntents  the application behind the token has not been granted a
//                      privileged intent it asks for. This bridge always
//                      requests MessageContent, which is privileged, so every
//                      bot whose portal switch was never ticked lands here and
//                      would otherwise retry for ever exactly like a bad
//                      token. The credential is intact; what it is allowed to
//                      do is not, and only a human in the portal changes that.
//
// Codes deliberately left retryable, so the distinction stays honest:
// ShardingRequired says the bot outgrew a single shard, which is a statement
// about scale rather than about the credential, and every transport error
// discord.js raises without a code of its own. Also left out are
// InvalidIntents and ClientMissingIntents: the library raises those from our
// own intent bits before it contacts Discord, so they are a defect in this
// repository rather than something an operator can fix, and config validation
// is where they belong.

/** A start() failure the channel provider will keep returning. */
export interface CredentialRejection {
  /** The provider's own error code, verbatim, so a log line can be searched for it. */
  code: string;
  /** The agents.yaml key holding the credential the provider refused. */
  credential: string;
  /** One line naming what a person has to do. Never carries the credential value. */
  detail: string;
}

/**
 * The refusals, keyed by provider error code. A Map rather than an object
 * literal because the key comes off an error thrown by a library: an object
 * lookup would answer for `toString` and every other Object.prototype member.
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
    "DisallowedIntents",
    {
      credential: "bot_token",
      detail:
        "The Discord application behind this bot token is not granted the Message Content intent. Enable it in the developer portal, under Bot and then Privileged Gateway Intents.",
    },
  ],
]);

/**
 * Classify a start() failure. Returns the rejection when the provider refused
 * the credential and retrying cannot change that, `undefined` for everything
 * else, which stays on the retry path.
 */
export function classifyCredentialRejection(err: unknown): CredentialRejection | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string") return undefined;
  const known = REJECTIONS.get(code);
  if (!known) return undefined;
  return { code, credential: known.credential, detail: known.detail };
}

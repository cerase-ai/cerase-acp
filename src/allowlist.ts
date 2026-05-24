import type { BridgeConfig } from "./config.js";

// Returns true iff `discordUserId` is in `agentId`'s `allowed_users`.
// Throws when `agentId` is not in the config — this is a programmer
// error (the dispatcher should never route to an unknown agent), not a
// user-facing condition, so a thrown error is the right shape.
export function isAllowed(
  config: BridgeConfig,
  agentId: string,
  discordUserId: string,
): boolean {
  const agent = config.agents.find((a) => a.id === agentId);
  if (!agent) {
    throw new Error(`agent id "${agentId}" is not in the bridge config`);
  }
  return agent.allowed_users.includes(discordUserId);
}

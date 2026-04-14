import crypto from "node:crypto";

import type { GatewayConfig } from "./types.js";

export function issueEphemeralInboundToken(
  config: GatewayConfig,
  matchId: number,
  peerAgentId: number,
  ttlMs = 5 * 60_000,
): { token: string; expiresAt: string } {
  const token = `match-${matchId}-peer-${peerAgentId}-${crypto.randomBytes(18).toString("hex")}`;
  config.security.validTokens.add(token);
  setTimeout(() => {
    config.security.validTokens.delete(token);
  }, ttlMs).unref?.();
  return {
    token,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
}

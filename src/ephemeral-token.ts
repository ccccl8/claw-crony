import crypto from "node:crypto";

import type { GatewayConfig } from "./types.js";

export const EPHEMERAL_INBOUND_TOKEN_LENGTH = 48;

const EPHEMERAL_INBOUND_TOKEN_PATTERN = /^[0-9a-f]{48}$/;

export function isValidEphemeralInboundToken(value: unknown): value is string {
  return typeof value === "string" && EPHEMERAL_INBOUND_TOKEN_PATTERN.test(value);
}

export function issueEphemeralInboundToken(
  config: GatewayConfig,
  _matchId: number,
  _peerAgentId: number,
  ttlMs = 5 * 60_000,
): { token: string; expiresAt: string } {
  const token = crypto.randomBytes(EPHEMERAL_INBOUND_TOKEN_LENGTH / 2).toString("hex");
  config.security.validTokens.add(token);
  setTimeout(() => {
    config.security.validTokens.delete(token);
  }, ttlMs).unref?.();
  return {
    token,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
}

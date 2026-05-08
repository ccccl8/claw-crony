import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  EPHEMERAL_INBOUND_TOKEN_LENGTH,
  isValidEphemeralInboundToken,
  issueEphemeralInboundToken,
} from "../src/ephemeral-token.js";
import { decryptHandshake, encryptHandshake } from "../src/handshake-crypto.js";
import type { GatewayConfig, HandshakePayload, IdentityData } from "../src/types.js";

function makeTokenConfig(): GatewayConfig {
  return {
    security: {
      validTokens: new Set<string>(),
    },
  } as GatewayConfig;
}

function makeIdentity(clientId: string): IdentityData {
  const keyPair = crypto.generateKeyPairSync("x25519");
  return {
    version: 1,
    clientId,
    publicKey: keyPair.publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKey: keyPair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    keyVersion: 1,
    createdAt: new Date().toISOString(),
  };
}

test("issueEphemeralInboundToken creates a fixed 48-character hex token", () => {
  const config = makeTokenConfig();
  const issued = issueEphemeralInboundToken(config, 123, 456);

  assert.equal(issued.token.length, EPHEMERAL_INBOUND_TOKEN_LENGTH);
  assert.match(issued.token, /^[0-9a-f]{48}$/);
  assert.equal(issued.token.includes("\u2026"), false);
  assert.equal(isValidEphemeralInboundToken(issued.token), true);
  assert.equal(config.security.validTokens.has(issued.token), true);
});

test("ephemeral token validation rejects truncated ellipsis strings and legacy prefixed tokens", () => {
  assert.equal(isValidEphemeralInboundToken("12345678901\u2026"), false);
  assert.equal(isValidEphemeralInboundToken("match-1-peer-2-1234567890abcdef1234567890abcdef"), false);
  assert.equal(isValidEphemeralInboundToken("1234567890abcdef1234567890abcdef"), false);
  assert.equal(isValidEphemeralInboundToken("1234567890abcdef1234567890abcdef1234567890abcdef"), true);
});

test("encrypted handshake preserves the full ephemeral token exactly", () => {
  const config = makeTokenConfig();
  const identity = makeIdentity("provider");
  const issued = issueEphemeralInboundToken(config, 1, 2);
  const payload: HandshakePayload = {
    version: 1,
    matchId: 1,
    sessionId: crypto.randomUUID(),
    fromAgentId: 2,
    toAgentId: 1,
    address: "http://127.0.0.1:18800",
    agentCardPath: "/.well-known/agent.json",
    token: issued.token,
    tokenExpiresAt: issued.expiresAt,
    protocols: ["jsonrpc", "rest", "grpc"],
    createdAt: new Date().toISOString(),
    nonce: crypto.randomBytes(12).toString("hex"),
  };

  const ciphertext = encryptHandshake(payload, identity.publicKey);
  const decrypted = decryptHandshake(ciphertext, identity);

  assert.equal(decrypted.token, issued.token);
  assert.equal(decrypted.token.length, EPHEMERAL_INBOUND_TOKEN_LENGTH);
  assert.equal(JSON.stringify(decrypted).includes("\u2026"), false);
});

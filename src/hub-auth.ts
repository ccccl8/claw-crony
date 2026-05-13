/**
 * Hub signing authentication client.
 *
 * Uses the local Ed25519 signing key to complete Hub challenge/verify and
 * returns a short-lived bearer token for authenticated Hub APIs.
 */

import crypto from "node:crypto";

import { loadOrCreateIdentity } from "./identity-store.js";
import { loadRegistration } from "./hub-registration.js";
import type { HubRegistrationData, IdentityData } from "./types.js";

interface AuthChallengeResponse {
  challengeId: string;
  clientId: string;
  agentId: number;
  algorithm: "ed25519";
  challenge: string;
  message: string;
  expiresAt: string;
  supported: boolean;
}

interface AuthVerifyResponse {
  ok: boolean;
  agentId: number;
  clientId: string;
  sessionId: string;
  token: string;
  tokenType: "Bearer";
  expiresAt: string;
}

async function requestJson<T>(hubUrl: string, path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${hubUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Hub auth API error ${res.status}: ${JSON.stringify(err)}`);
  }

  return res.json() as Promise<T>;
}

function requireSigningIdentity(identity: IdentityData): Required<Pick<IdentityData, "signingPrivateKey" | "signingAlgorithm">> {
  if (!identity.signingPrivateKey) {
    throw new Error("Local identity does not have an Ed25519 signing private key. Restart the plugin to upgrade identity.");
  }
  if (identity.signingAlgorithm && identity.signingAlgorithm !== "ed25519") {
    throw new Error(`Unsupported local signing algorithm: ${identity.signingAlgorithm}`);
  }
  return {
    signingPrivateKey: identity.signingPrivateKey,
    signingAlgorithm: "ed25519",
  };
}

function signChallengeMessage(identity: IdentityData, message: string): string {
  const signing = requireSigningIdentity(identity);
  const key = crypto.createPrivateKey(signing.signingPrivateKey);
  return crypto.sign(null, Buffer.from(message, "utf-8"), key).toString("base64url");
}

export async function getHubBearerToken(registration?: HubRegistrationData): Promise<string> {
  const reg = registration ?? loadRegistration();
  if (!reg) {
    throw new Error("No hub registration found. Run the gateway first to register with the hub.");
  }

  const identity = loadOrCreateIdentity(reg.clientId);
  const challenge = await requestJson<AuthChallengeResponse>(reg.hubUrl, "/api/auth/challenge", {
    clientId: reg.clientId,
  });
  if (challenge.clientId !== reg.clientId || challenge.agentId !== reg.agentId) {
    throw new Error("Hub auth challenge does not match local registration");
  }
  if (challenge.algorithm !== "ed25519" || !challenge.supported) {
    throw new Error(`Hub auth challenge uses unsupported algorithm: ${challenge.algorithm}`);
  }

  const signature = signChallengeMessage(identity, challenge.message);
  const verified = await requestJson<AuthVerifyResponse>(reg.hubUrl, "/api/auth/verify", {
    clientId: reg.clientId,
    challengeId: challenge.challengeId,
    algorithm: "ed25519",
    signature,
  });

  if (!verified.ok || verified.tokenType !== "Bearer" || !verified.token) {
    throw new Error("Hub auth verification did not return a bearer token");
  }
  if (verified.clientId !== reg.clientId || verified.agentId !== reg.agentId) {
    throw new Error("Hub auth verification does not match local registration");
  }

  return verified.token;
}

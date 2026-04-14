import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { IdentityData } from "./types.js";

const IDENTITY_FILENAME = "a2a-identity.json";

function getConfigDir(): string {
  return path.join(os.homedir(), ".openclaw");
}

function getIdentityPath(configDir: string): string {
  return path.join(configDir, IDENTITY_FILENAME);
}

function randomClientId(): string {
  return crypto.randomUUID();
}

export function loadIdentity(configDir?: string): IdentityData | null {
  const identityPath = getIdentityPath(configDir ?? getConfigDir());
  try {
    const raw = fs.readFileSync(identityPath, "utf-8");
    return JSON.parse(raw) as IdentityData;
  } catch {
    return null;
  }
}

export function saveIdentity(configDir: string, data: IdentityData): void {
  const identityPath = getIdentityPath(configDir);
  const tmpPath = `${identityPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmpPath, identityPath);
}

export function loadOrCreateIdentity(clientId?: string): IdentityData {
  const configDir = getConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const existing = loadIdentity(configDir);
  if (existing) {
    if (clientId && existing.clientId !== clientId) {
      existing.clientId = clientId;
      saveIdentity(configDir, existing);
    }
    return existing;
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const identity: IdentityData = {
    version: 1,
    clientId: clientId?.trim() || randomClientId(),
    publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    keyVersion: 1,
    createdAt: new Date().toISOString(),
  };
  saveIdentity(configDir, identity);
  return identity;
}

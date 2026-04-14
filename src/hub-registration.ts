/**
 * Hub registration module for claw-crony.
 *
 * Registers the local plugin with the hub using client_id + public_key
 * and persists the resulting agent binding locally.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  GatewayConfig,
  HubConfig,
  HubRegistrationData,
  OpenClawPluginApi,
  RegistrationConfig,
} from "./types.js";
import { loadOrCreateIdentity } from "./identity-store.js";

const REGISTRATION_FILENAME = "a2a-registration.json";

function getRegistrationPath(configDir: string): string {
  return path.join(configDir, REGISTRATION_FILENAME);
}

function getConfigDir(): string {
  return path.join(os.homedir(), ".openclaw");
}

export function loadRegistration(configDir?: string): HubRegistrationData | null {
  const regPath = getRegistrationPath(configDir ?? getConfigDir());
  try {
    const raw = fs.readFileSync(regPath, "utf-8");
    return JSON.parse(raw) as HubRegistrationData;
  } catch {
    return null;
  }
}

export function saveRegistration(configDir: string, data: HubRegistrationData): void {
  const regPath = path.join(configDir, REGISTRATION_FILENAME);
  const tmpPath = `${regPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmpPath, regPath);
}

interface HubAgentDto {
  id: number;
  name: string;
  description: string;
  skills: string[];
  status: string;
  clientId?: string;
  publicKey?: string;
  username?: string;
  email?: string;
}

interface CreateAgentPayload {
  name: string;
  description: string;
  skills: string[];
  clientId: string;
  publicKey: string;
  keyVersion: number;
  clientVersion?: string;
  username?: string;
  email?: string;
}

async function registerHubUser(
  hubUrl: string,
  agentId: number,
  username: string,
  password: string,
): Promise<void> {
  const url = `${hubUrl.replace(/\/$/, "")}/api/hub-users/register`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, username, password }),
  });

  if (res.status === 409) {
    return;
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Hub user registration failed: ${JSON.stringify(err)}`);
  }
}

async function registerWithHub(hubUrl: string, payload: CreateAgentPayload): Promise<HubAgentDto> {
  const url = `${hubUrl.replace(/\/$/, "")}/api/agents`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(`Hub rejected registration: ${JSON.stringify(err)}`), { status: res.status });
  }

  return res.json() as Promise<HubAgentDto>;
}

async function lookupAgentByClientId(hubUrl: string, clientId: string): Promise<HubAgentDto | null> {
  const url = `${hubUrl.replace(/\/$/, "")}/api/agents?clientId=${encodeURIComponent(clientId)}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw Object.assign(new Error(`Hub lookup failed: ${res.status}`), { status: res.status });
  }

  const agents: HubAgentDto[] = await res.json();
  return agents.length > 0 ? agents[0] : null;
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelayMs: number,
  maxDelayMs: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

function flattenSkills(skills: Array<{ id?: string; name: string; description?: string } | string>): string[] {
  return skills.map((s) => (typeof s === "string" ? s : s.name));
}

export interface HubRegistration {
  agentId: number;
  token: string;
  address: string;
  name: string;
}

export async function runHubRegistration(
  api: OpenClawPluginApi,
  config: GatewayConfig,
  hubConfig: HubConfig,
  registrationConfig: RegistrationConfig,
): Promise<HubRegistration | null> {
  const configDir = getConfigDir();
  const hubUrl = hubConfig.url;
  const identity = loadOrCreateIdentity(registrationConfig.clientId);

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const existing = loadRegistration(configDir);
  if (
    existing &&
    existing.hubUrl === hubUrl &&
    existing.clientId === identity.clientId &&
    existing.publicKey === identity.publicKey
  ) {
    try {
      const agent = await lookupAgentByClientId(hubUrl, identity.clientId);
      if (agent && agent.id === existing.agentId) {
        api.logger.info(`claw-crony: using existing hub registration (agentId=${existing.agentId})`);
        return {
          agentId: existing.agentId,
          token: "",
          address: "",
          name: existing.name,
        };
      }
    } catch {
      api.logger.warn("claw-crony: existing registration not confirmed remotely, re-registering");
    }
  }

  const name = config.agentCard.name;
  const description = config.agentCard.description ?? "";
  const skills = flattenSkills(config.agentCard.skills);
  const username = registrationConfig.username ?? name;
  const email = registrationConfig.email ?? "";

  const payload: CreateAgentPayload = {
    name,
    description,
    skills,
    clientId: identity.clientId,
    publicKey: identity.publicKey,
    keyVersion: identity.keyVersion,
    clientVersion: "claw-crony/1.2.3",
    username,
    email,
  };

  let agentId: number;

  try {
    const agent = await retryWithBackoff(
      () => registerWithHub(hubUrl, payload),
      3,
      1000,
      10000,
    );
    agentId = agent.id;
    api.logger.info(`claw-crony: registered with hub (agentId=${agentId})`);

    if (registrationConfig.password) {
      try {
        await retryWithBackoff(
          () => registerHubUser(hubUrl, agentId, username, registrationConfig.password!),
          3,
          1000,
          10000,
        );
        api.logger.info(`claw-crony: registered hub user for web login (agentId=${agentId})`);
      } catch (err) {
        api.logger.warn(`claw-crony: hub user registration failed - ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      api.logger.info(
        `claw-crony: Agent registered with hub (agentId=${agentId}). ` +
        `Visit ${hubUrl}/register to create your web dashboard account.`,
      );
    }
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && (err as { status?: number }).status === 409) {
      try {
        const existingAgent = await lookupAgentByClientId(hubUrl, identity.clientId);
        if (!existingAgent) {
          api.logger.error("claw-crony: identity conflict but could not find existing agent");
          return null;
        }
        agentId = existingAgent.id;
        api.logger.info(`claw-crony: found existing registration (agentId=${agentId})`);
      } catch {
        api.logger.error("claw-crony: identity conflict and hub lookup failed");
        return null;
      }
    } else {
      api.logger.warn(`claw-crony: hub registration failed - ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  const registrationData: HubRegistrationData = {
    version: 2,
    hubUrl,
    agentId,
    clientId: identity.clientId,
    publicKey: identity.publicKey,
    keyVersion: identity.keyVersion,
    registeredAt: new Date().toISOString(),
    name,
    description,
    skills,
  };

  try {
    saveRegistration(configDir, registrationData);
  } catch (saveErr) {
    api.logger.warn(`claw-crony: failed to save registration file - ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`);
  }

  return { agentId, token: "", address: "", name };
}

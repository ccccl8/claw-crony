/**
 * Hub registration module for openclaw-a2a-gateway.
 *
 * Handles automatic registration of the gateway with the hub server on first startup,
 * token generation, and idempotent re-registration.
 */

import crypto from "node:crypto";
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

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

// ---------------------------------------------------------------------------
// Registration file path & I/O
// ---------------------------------------------------------------------------

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

export function saveRegistration(
  configDir: string,
  data: HubRegistrationData,
): void {
  const regPath = path.join(configDir, REGISTRATION_FILENAME);
  const tmpPath = `${regPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmpPath, regPath);
}

// ---------------------------------------------------------------------------
// Hub API calls
// ---------------------------------------------------------------------------

interface HubAgentDto {
  id: number;
  name: string;
  description: string;
  skills: string[];
  address: string;
  status: string;
  username?: string;
  email?: string;
}

interface CreateAgentPayload {
  name: string;
  description: string;
  skills: string[];
  address: string;
  token: string;
  username?: string;
  email?: string;
}

async function registerWithHub(hubUrl: string, payload: CreateAgentPayload): Promise<HubAgentDto> {
  const url = `${hubUrl.replace(/\/$/, "")}/api/agents`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (res.status === 409) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error("Agent address already registered"), { status: 409, body: err });
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(`Hub rejected registration: ${JSON.stringify(err)}`), { status: res.status });
  }

  return res.json() as Promise<HubAgentDto>;
}

async function lookupAgentByAddress(hubUrl: string, address: string): Promise<HubAgentDto | null> {
  const url = `${hubUrl.replace(/\/$/, "")}/api/agents?address=${encodeURIComponent(address)}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw Object.assign(new Error(`Hub lookup failed: ${res.status}`), { status: res.status });
  }

  const agents: HubAgentDto[] = await res.json();
  return agents.length > 0 ? agents[0] : null;
}

// ---------------------------------------------------------------------------
// Retry with exponential backoff
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Flatten skills from agent card config
// ---------------------------------------------------------------------------

function flattenSkills(skills: Array<{ id?: string; name: string; description?: string } | string>): string[] {
  return skills.map((s) => (typeof s === "string" ? s : s.name));
}

// ---------------------------------------------------------------------------
// Hub registration interface
// ---------------------------------------------------------------------------

export interface HubRegistration {
  agentId: number;
  token: string;
  address: string;
  name: string;
}

/**
 * Run the full hub registration flow:
 * 1. Load existing registration (if any)
 * 2. Validate existing token with hub
 * 3. If no valid registration, create new one (handling 409 conflicts)
 * 4. Save registration file atomically
 */
export async function runHubRegistration(
  api: OpenClawPluginApi,
  config: GatewayConfig,
  hubConfig: HubConfig,
  registrationConfig: RegistrationConfig,
): Promise<HubRegistration | null> {
  const configDir = getConfigDir();
  const hubUrl = hubConfig.url;
  const address = `${config.server.host}:${config.server.port}`;

  // Ensure config directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Load existing registration
  const existing = loadRegistration(configDir);

  // If we have a registration with a matching address and token, validate it
  if (existing && existing.address === address && existing.hubUrl === hubUrl && existing.token) {
    try {
      const agent = await lookupAgentByAddress(hubUrl, address);
      if (agent && agent.id === existing.agentId) {
        api.logger.info(`a2a-gateway: using existing hub registration (agentId=${existing.agentId})`);
        return {
          agentId: existing.agentId,
          token: existing.token,
          address: existing.address,
          name: existing.name,
        };
      }
    } catch {
      // Hub unreachable or agent not found — will re-register
      api.logger.warn("a2a-gateway: existing registration invalid, will re-register");
    }
  }

  // Generate new token
  const token = generateToken();
  const name = config.agentCard.name;
  const description = config.agentCard.description ?? "";
  const skills = flattenSkills(config.agentCard.skills);
  const username = registrationConfig.username ?? name;
  const email = registrationConfig.email ?? "";

  const payload: CreateAgentPayload = {
    name,
    description,
    skills,
    address,
    token,
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
    api.logger.info(`a2a-gateway: registered with hub (agentId=${agentId})`);
  } catch (err: unknown) {
    // 409 Conflict: address already registered by someone else — try to find our agentId
    if (typeof err === "object" && err !== null && (err as { status?: number }).status === 409) {
      try {
        const existingAgent = await lookupAgentByAddress(hubUrl, address);
        if (existingAgent) {
          agentId = existingAgent.id;
          api.logger.info(`a2a-gateway: found existing registration (agentId=${agentId})`);
        } else {
          api.logger.error("a2a-gateway: address conflict but could not find existing agent");
          return null;
        }
      } catch {
        api.logger.error("a2a-gateway: address conflict and hub lookup failed");
        return null;
      }
    } else {
      api.logger.warn(`a2a-gateway: hub registration failed — ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // Save registration file
  const registrationData: HubRegistrationData = {
    version: 1,
    hubUrl,
    agentId,
    address,
    token,
    registeredAt: new Date().toISOString(),
    name,
    description,
    skills,
  };

  try {
    saveRegistration(configDir, registrationData);
  } catch (saveErr) {
    api.logger.warn(`a2a-gateway: failed to save registration file — ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`);
  }

  return { agentId, token, address, name };
}

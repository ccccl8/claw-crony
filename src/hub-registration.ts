/**
 * Hub registration module for claw-crony.
 *
 * Registers the local plugin with the hub using client_id, X25519 public key,
 * and Ed25519 signing public key, then persists the resulting agent binding.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ConnectionDescriptor,
  ConnectionEndpoint,
  GatewayConfig,
  HubConfig,
  HubRegistrationData,
  IdentityData,
  OpenClawPluginApi,
  RegistrationConfig,
} from "./types.js";
import { buildAgentCard } from "./agent-card.js";
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
  signingPublicKey?: string;
  signingKeyVersion?: number;
  signingAlgorithm?: string;
  signingKeyStatus?: string;
  connectionDescriptor?: ConnectionDescriptor;
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
  signingPublicKey?: string;
  signingKeyVersion?: number;
  signingAlgorithm?: "ed25519";
  clientVersion?: string;
  username?: string;
  email?: string;
  connectionDescriptor?: ConnectionDescriptor;
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

function authMode(config: GatewayConfig): string {
  return config.security?.inboundAuth === "bearer" ? "bearer" : "none";
}

function normalizeTransport(transport: string): string {
  switch (transport) {
    case "JSONRPC":
      return "jsonrpc";
    case "HTTP+JSON":
      return "http-json";
    case "GRPC":
      return "grpc";
    default:
      return transport.toLowerCase();
  }
}

function endpointAgentCardUrl(url: string): string | undefined {
  try {
    return `${new URL(url).origin}/.well-known/agent.json`;
  } catch {
    return undefined;
  }
}

function dedupeEndpoints(endpoints: ConnectionEndpoint[]): ConnectionEndpoint[] {
  const seen = new Set<string>();
  return endpoints.filter((endpoint) => {
    const key = `${endpoint.protocol}:${endpoint.transport}:${endpoint.url}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function buildHubConnectionDescriptor(
  config: GatewayConfig,
  identity: Pick<IdentityData, "clientId" | "publicKey" | "keyVersion" | "signingPublicKey" | "signingKeyVersion" | "signingAlgorithm">,
  skills: string[],
): ConnectionDescriptor {
  const agentCard = buildAgentCard(config);
  const endpoints = dedupeEndpoints(
    (agentCard.additionalInterfaces && agentCard.additionalInterfaces.length > 0
      ? agentCard.additionalInterfaces
      : [{ url: agentCard.url, transport: agentCard.preferredTransport ?? "JSONRPC" }]
    ).map((endpoint) => {
      const agentCardUrl = endpointAgentCardUrl(endpoint.url);
      return {
        protocol: "a2a",
        transport: normalizeTransport(endpoint.transport),
        url: endpoint.url,
        auth: authMode(config),
        metadata: agentCardUrl ? { agentCardUrl } : undefined,
      };
    }),
  );

  return {
    version: "openclaw-connect/1",
    clientId: identity.clientId,
    displayName: agentCard.name,
    publicKeys: {
      encryption: {
        type: "X25519",
        publicKey: identity.publicKey,
        keyVersion: identity.keyVersion,
      },
      signing: identity.signingPublicKey
        ? {
            type: "Ed25519",
            publicKey: identity.signingPublicKey,
            keyVersion: identity.signingKeyVersion ?? 1,
            algorithm: identity.signingAlgorithm ?? "ed25519",
            status: "active",
          }
        : undefined,
    },
    endpoints,
    capabilities: {
      skills,
      protocols: ["a2a"],
      inputModes: agentCard.defaultInputModes ?? ["text"],
      outputModes: agentCard.defaultOutputModes ?? ["text"],
      metadata: {
        streaming: agentCard.capabilities.streaming,
        pushNotifications: agentCard.capabilities.pushNotifications,
      },
    },
    metadata: {
      implementation: "claw-crony",
      agentCardProtocolVersion: agentCard.protocolVersion,
    },
  };
}

function sameDescriptor(a?: ConnectionDescriptor, b?: ConnectionDescriptor): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function hasMatchingSigningKey(agent: HubAgentDto, signingPublicKey?: string): boolean {
  return Boolean(
    signingPublicKey &&
    agent.signingPublicKey === signingPublicKey &&
    (!agent.signingAlgorithm || agent.signingAlgorithm === "ed25519") &&
    (!agent.signingKeyStatus || agent.signingKeyStatus === "active"),
  );
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
  const name = config.agentCard.name;
  const description = config.agentCard.description ?? "";
  const skills = flattenSkills(config.agentCard.skills);
  const username = registrationConfig.username ?? name;
  const email = registrationConfig.email ?? "";
  const connectionDescriptor = buildHubConnectionDescriptor(config, identity, skills);

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const existing = loadRegistration(configDir);
  if (
    existing &&
    existing.hubUrl === hubUrl &&
    existing.clientId === identity.clientId &&
    existing.publicKey === identity.publicKey &&
    existing.signingPublicKey === identity.signingPublicKey &&
    sameDescriptor(existing.connectionDescriptor, connectionDescriptor)
  ) {
    try {
      const agent = await lookupAgentByClientId(hubUrl, identity.clientId);
      if (agent && agent.id === existing.agentId && hasMatchingSigningKey(agent, identity.signingPublicKey)) {
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

  const payload: CreateAgentPayload = {
    name,
    description,
    skills,
    clientId: identity.clientId,
    publicKey: identity.publicKey,
    keyVersion: identity.keyVersion,
    signingPublicKey: identity.signingPublicKey,
    signingKeyVersion: identity.signingKeyVersion ?? 1,
    signingAlgorithm: "ed25519",
    clientVersion: "claw-crony/1.3.0",
    username,
    email,
    connectionDescriptor,
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
    version: 4,
    hubUrl,
    agentId,
    clientId: identity.clientId,
    publicKey: identity.publicKey,
    keyVersion: identity.keyVersion,
    signingPublicKey: identity.signingPublicKey,
    signingKeyVersion: identity.signingKeyVersion ?? 1,
    signingAlgorithm: "ed25519",
    registeredAt: new Date().toISOString(),
    name,
    description,
    skills,
    connectionDescriptor,
  };

  try {
    saveRegistration(configDir, registrationData);
  } catch (saveErr) {
    api.logger.warn(`claw-crony: failed to save registration file - ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`);
  }

  return { agentId, token: "", address: "", name };
}

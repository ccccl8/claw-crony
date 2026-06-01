import type { HubAgentDto, HubMatchResult } from "./hub-match.js";
import type { ConnectionDescriptor, ConnectionEndpoint, ConnectionKeyRef } from "./types.js";

export interface ResolvedHubAgent {
  agentId: number;
  name: string;
  description?: string;
  skills: string[];
  status?: string;
  presenceStatus?: string;
  clientId?: string;
  clientVersion?: string;
  official?: boolean;
  verified?: boolean;
  operatorName?: string;
  sourceRepoUrl?: string;
  documentationUrl?: string;
  privacyPolicyUrl?: string;
  riskBoundary?: string;
  agentType?: string;
  domain?: string;
  modelProvider?: string;
  modelName?: string;
  modelDisplayName?: string;
  modelUsage?: string;
  dataRetention?: string;
  capabilityManifest?: Record<string, unknown>;
  publicKeys: {
    encryption?: ConnectionKeyRef;
    signing?: ConnectionKeyRef;
  };
  connectionProtocols: string[];
  endpoints: ConnectionEndpoint[];
  connectionDescriptor?: ConnectionDescriptor;
  lastSeenAt?: string | null;
}

export interface GenericMatchResolution {
  ok: true;
  mode: "generic_match" | "resolve";
  matchId?: number;
  status?: string;
  callerRole?: HubMatchResult["callerRole"];
  localAgentId: number;
  local?: ResolvedHubAgent | null;
  peer: ResolvedHubAgent | null;
  match?: {
    id: number;
    requestId?: number | null;
    status: string;
    requesterAgentId?: number;
    providerAgentId?: number;
  };
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function descriptorProtocols(descriptor?: ConnectionDescriptor): string[] {
  return [
    ...(descriptor?.capabilities?.protocols ?? []),
    ...(descriptor?.endpoints ?? []).map((endpoint) => endpoint.protocol),
  ];
}

function stringValue(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

function capabilityValue(capabilityManifest: Record<string, unknown> | undefined, key: string): string | undefined {
  return stringValue(capabilityManifest?.[key]);
}

function metadataValue(capabilityManifest: Record<string, unknown> | undefined, key: string): string | undefined {
  const metadata = capabilityManifest?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  return stringValue((metadata as Record<string, unknown>)[key]);
}

function modelDisplayName(provider?: string, modelName?: string): string | undefined {
  if (provider && modelName) {
    return `${provider} / ${modelName}`;
  }
  return provider ?? modelName;
}

function fallbackEncryptionKey(agent: HubAgentDto): ConnectionKeyRef | undefined {
  if (!agent.publicKey) {
    return undefined;
  }

  return {
    type: "X25519",
    publicKey: agent.publicKey,
    keyVersion: agent.keyVersion ?? 1,
  };
}

function fallbackSigningKey(agent: HubAgentDto): ConnectionKeyRef | undefined {
  if (!agent.signingPublicKey) {
    return undefined;
  }

  return {
    type: "Ed25519",
    publicKey: agent.signingPublicKey,
    keyVersion: agent.signingKeyVersion ?? 1,
    algorithm: agent.signingAlgorithm ?? "ed25519",
    status: agent.signingKeyStatus ?? "active",
  };
}

export function summarizeHubAgent(agent: HubAgentDto | null | undefined): ResolvedHubAgent | null {
  if (!agent) {
    return null;
  }

  const descriptor = agent.connectionDescriptor;
  const capabilityManifest = agent.capabilityManifest;
  const modelProvider = stringValue(agent.modelProvider) ?? metadataValue(capabilityManifest, "modelProvider");
  const modelName = stringValue(agent.modelName) ?? metadataValue(capabilityManifest, "modelName");
  const publicKeys = {
    encryption: descriptor?.publicKeys?.encryption ?? fallbackEncryptionKey(agent),
    signing: descriptor?.publicKeys?.signing ?? fallbackSigningKey(agent),
  };

  return {
    agentId: agent.id,
    name: agent.name,
    description: agent.description,
    skills: agent.skills ?? [],
    status: agent.status,
    presenceStatus: agent.presenceStatus,
    clientId: agent.clientId,
    clientVersion: agent.clientVersion,
    official: agent.official,
    verified: agent.verified,
    operatorName: agent.operatorName,
    sourceRepoUrl: agent.sourceRepoUrl,
    documentationUrl: agent.documentationUrl,
    privacyPolicyUrl: agent.privacyPolicyUrl,
    riskBoundary: stringValue(agent.riskBoundary) ?? capabilityValue(capabilityManifest, "riskBoundary"),
    agentType: stringValue(agent.agentType) ?? metadataValue(capabilityManifest, "agentType"),
    domain: stringValue(agent.domain) ?? metadataValue(capabilityManifest, "domain"),
    modelProvider,
    modelName,
    modelDisplayName: stringValue(agent.modelDisplayName) ?? modelDisplayName(modelProvider, modelName),
    modelUsage: stringValue(agent.modelUsage) ?? metadataValue(capabilityManifest, "modelUsage"),
    dataRetention: stringValue(agent.dataRetention) ?? metadataValue(capabilityManifest, "dataRetention"),
    capabilityManifest,
    publicKeys,
    connectionProtocols: dedupeStrings([
      ...(agent.connectionProtocols ?? []),
      ...descriptorProtocols(descriptor),
    ]),
    endpoints: descriptor?.endpoints ?? [],
    connectionDescriptor: descriptor,
    lastSeenAt: agent.lastSeenAt,
  };
}

export function selectLocalAndPeerAgents(match: HubMatchResult, localAgentId: number): {
  local: HubAgentDto | null;
  peer: HubAgentDto | null;
} {
  if (match.requester?.id === localAgentId) {
    return { local: match.requester, peer: match.provider };
  }
  if (match.provider?.id === localAgentId) {
    return { local: match.provider, peer: match.requester };
  }
  if (match.callerRole === "requester") {
    return { local: match.requester, peer: match.provider };
  }
  if (match.callerRole === "provider") {
    return { local: match.provider, peer: match.requester };
  }
  return { local: null, peer: match.provider ?? match.requester };
}

export function buildGenericMatchResolution(
  match: HubMatchResult,
  localAgentId: number,
  mode: GenericMatchResolution["mode"] = "generic_match",
): GenericMatchResolution {
  const selected = selectLocalAndPeerAgents(match, localAgentId);
  return {
    ok: true,
    mode,
    matchId: match.id,
    status: match.status,
    callerRole: match.callerRole,
    localAgentId,
    local: summarizeHubAgent(selected.local),
    peer: summarizeHubAgent(selected.peer),
    match: {
      id: match.id,
      requestId: match.requestId,
      status: match.status,
      requesterAgentId: match.requester?.id,
      providerAgentId: match.provider?.id,
    },
  };
}

export function buildAgentResolution(agent: HubAgentDto, localAgentId: number): GenericMatchResolution {
  return {
    ok: true,
    mode: "resolve",
    localAgentId,
    peer: summarizeHubAgent(agent),
  };
}

export function formatResolvedHubAgent(agent: ResolvedHubAgent | null): string {
  if (!agent) {
    return "No peer agent was resolved.";
  }

  const protocols = agent.connectionProtocols.length > 0 ? agent.connectionProtocols.join(", ") : "(none)";
  const endpoints = agent.endpoints.length > 0
    ? agent.endpoints.map((endpoint) => `- ${endpoint.protocol}/${endpoint.transport}: ${endpoint.url}`).join("\n")
    : "- (none)";
  const badges = [
    agent.official ? "official" : undefined,
    agent.verified ? "verified" : undefined,
    agent.operatorName ? `operator=${agent.operatorName}` : undefined,
  ].filter(Boolean).join(", ");
  const facts = [
    badges ? `Trust: ${badges}` : undefined,
    agent.riskBoundary ? `Boundary: ${agent.riskBoundary}` : undefined,
    agent.agentType ? `Type: ${agent.agentType}` : undefined,
    agent.domain ? `Domain: ${agent.domain}` : undefined,
    agent.modelDisplayName ? `Model: ${agent.modelDisplayName}` : undefined,
    agent.modelUsage ? `Model use: ${agent.modelUsage}` : undefined,
    agent.dataRetention ? `Retention: ${agent.dataRetention}` : undefined,
    agent.sourceRepoUrl ? `Source: ${agent.sourceRepoUrl}` : undefined,
    agent.documentationUrl ? `Docs: ${agent.documentationUrl}` : undefined,
    agent.privacyPolicyUrl ? `Privacy: ${agent.privacyPolicyUrl}` : undefined,
  ].filter((line): line is string => Boolean(line));

  return [
    `${agent.name} (agentId=${agent.agentId})`,
    `Presence: ${agent.presenceStatus ?? "unknown"}`,
    `Skills: ${(agent.skills ?? []).join(", ") || "(none)"}`,
    `Protocols: ${protocols}`,
    ...facts,
    "Endpoints:",
    endpoints,
  ].join("\n");
}

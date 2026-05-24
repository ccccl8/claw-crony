/**
 * Hub plaza/profile API client for claw-crony.
 */

import { loadIdentity } from "./identity-store.js";
import { loadRegistration } from "./hub-registration.js";
import { getHubBearerToken } from "./hub-auth.js";
import type { GatewayConfig, HubRegistrationData, IdentityData, ProfileConfig } from "./types.js";

export interface PlazaAgentView {
  agentId: number;
  name: string;
  displayName?: string;
  description?: string;
  headline?: string;
  bio?: string;
  plazaMessage?: string;
  contactHint?: string;
  plazaEnabled?: boolean;
  skills: string[];
  displaySkills?: string[];
  connectionProtocols?: string[];
  presenceStatus?: string;
  clientVersion?: string;
  lastSeenAt?: string | null;
  updatedAt?: string | null;
}

export interface HubProfileUpdate {
  agentId?: number;
  clientId?: string;
  publicKey?: string;
  name?: string;
  description?: string;
  skills?: string[];
  displayName?: string;
  headline?: string;
  bio?: string;
  plazaEnabled?: boolean;
  plazaMessage?: string;
  contactHint?: string;
}

export interface PlazaListQuery {
  skill?: string;
  q?: string;
}

function flattenSkills(config: GatewayConfig): string[] {
  return config.agentCard.skills
    .map((skill) => typeof skill === "string" ? skill : skill.name)
    .filter((skill) => skill && skill.trim().length > 0);
}

function trimOptional(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildProfileUpdatePayload(
  config: GatewayConfig,
  registration: HubRegistrationData,
  identity: IdentityData,
  override: HubProfileUpdate = {},
): HubProfileUpdate {
  const profile: ProfileConfig = config.profile;
  return {
    agentId: registration.agentId,
    clientId: identity.clientId,
    publicKey: identity.publicKey,
    name: config.agentCard.name,
    description: config.agentCard.description ?? "",
    skills: flattenSkills(config),
    displayName: trimOptional(profile.displayName),
    headline: trimOptional(profile.headline),
    bio: trimOptional(profile.bio),
    plazaEnabled: profile.plazaEnabled,
    plazaMessage: trimOptional(profile.plazaMessage),
    contactHint: trimOptional(profile.contactHint),
    ...override,
  };
}

export class HubProfileClient {
  private readonly hubUrl: string;

  constructor(hubUrl: string) {
    this.hubUrl = hubUrl.replace(/\/$/, "");
  }

  static createFromRegistration(): HubProfileClient {
    const registration = loadRegistration();
    if (!registration) {
      throw new Error("No hub registration found. Run the gateway first to register with the hub.");
    }
    return new HubProfileClient(registration.hubUrl);
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.hubUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Hub profile API error ${res.status}: ${JSON.stringify(body)}`);
    }

    return res.json() as Promise<T>;
  }

  async listPlazaAgents(query: PlazaListQuery = {}): Promise<PlazaAgentView[]> {
    const params = new URLSearchParams();
    if (query.skill) params.set("skill", query.skill);
    if (query.q) params.set("q", query.q);
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return this.request<PlazaAgentView[]>(`/api/plaza/agents${suffix}`);
  }

  async getProfile(agentId: number): Promise<PlazaAgentView> {
    return this.request<PlazaAgentView>(`/api/plaza/agents/${agentId}`);
  }

  async updateProfile(payload: HubProfileUpdate, bearerToken?: string): Promise<PlazaAgentView> {
    return this.request<PlazaAgentView>("/api/me/profile", {
      method: "PUT",
      headers: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : undefined,
      body: JSON.stringify(payload),
    });
  }
}

export async function syncHubProfile(config: GatewayConfig, override: HubProfileUpdate = {}): Promise<PlazaAgentView> {
  const registration = loadRegistration();
  if (!registration) {
    throw new Error("No hub registration found. Run the gateway first to register with the hub.");
  }

  const identity = loadIdentity();
  if (!identity) {
    throw new Error("No local identity found. Restart the plugin and try again.");
  }

  const client = new HubProfileClient(registration.hubUrl);
  const bearerToken = await getHubBearerToken(registration);
  return client.updateProfile(buildProfileUpdatePayload(config, registration, identity, override), bearerToken);
}

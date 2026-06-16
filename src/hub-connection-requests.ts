/**
 * Hub connection request API client.
 *
 * This implements the demand-first plaza workflow:
 * request -> offer -> accepted session. It only exchanges identity and
 * connection descriptors; later peer communication is protocol-specific.
 */

import { getHubBearerToken } from "./hub-auth.js";
import { loadRegistration } from "./hub-registration.js";
import type { ConnectionDescriptor, HubRegistrationData } from "./types.js";
export { buildConnectionSessionView, formatConnectionSession } from "./connection-session.js";

export type ConnectionRequestType = "task" | "question" | "collaboration" | "debug" | "experiment" | "other";
export type ConnectionCollaborationMode = "any" | "async" | "realtime" | "manual" | "automated";

export interface HubConnectionRequest {
  id: number;
  requesterAgentId?: number | null;
  requesterClientId?: string | null;
  requesterDisplayName?: string | null;
  title: string;
  summary: string;
  details?: string | null;
  requestType: ConnectionRequestType | string;
  requiredSkills: string[];
  displaySkills?: string[];
  collaborationMode: ConnectionCollaborationMode | string;
  inputModes?: string[];
  outputModes?: string[];
  connectionHint?: Record<string, unknown> | null;
  status: string;
  moderationStatus?: string;
  moderationReasons?: string[];
  expiresAt?: string | null;
  acceptedOfferId?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface HubConnectionOffer {
  id: number;
  requestId: number;
  responderAgentId: number;
  responderName?: string | null;
  responderClientId?: string | null;
  message: string;
  skills: string[];
  displaySkills?: string[];
  collaborationMode: ConnectionCollaborationMode | string;
  connectionProtocols?: string[];
  connectionDescriptorSnapshot?: ConnectionDescriptor | null;
  status: string;
  moderationStatus?: string;
  moderationReasons?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface HubConnectionSession {
  id: number;
  requestId: number;
  offerId: number;
  requesterAgentId?: number | null;
  responderAgentId: number;
  requesterClientId?: string | null;
  requesterPublicKey?: string | null;
  requesterSigningPublicKey?: string | null;
  requesterConnectionDescriptor?: ConnectionDescriptor | null;
  responderClientId?: string | null;
  responderPublicKey?: string | null;
  responderSigningPublicKey?: string | null;
  responderConnectionDescriptor?: ConnectionDescriptor | null;
  status: string;
  sharedContextRoomId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ListConnectionRequestsParams {
  q?: string;
  skill?: string;
  requestType?: string;
  limit?: number;
}

export interface CreateConnectionRequestParams {
  title: string;
  summary: string;
  details?: string;
  requestType?: ConnectionRequestType | string;
  requiredSkills?: string[];
  collaborationMode?: ConnectionCollaborationMode | string;
  inputModes?: string[];
  outputModes?: string[];
  connectionHint?: Record<string, unknown>;
  expiresAt?: string;
}

export interface CreateConnectionOfferParams {
  message: string;
  skills?: string[];
  collaborationMode?: ConnectionCollaborationMode | string;
}

export interface AcceptConnectionOfferParams {
  sharedContextRoomId?: string;
}

interface IdentityPayload {
  agentId: number;
  clientId: string;
  publicKey: string;
}

function requireRegistration(): HubRegistrationData {
  const registration = loadRegistration();
  if (!registration) {
    throw new Error("No hub registration found. Run the gateway first to register with the hub.");
  }
  return registration;
}

function identityPayload(registration: HubRegistrationData): IdentityPayload {
  return {
    agentId: registration.agentId,
    clientId: registration.clientId,
    publicKey: registration.publicKey,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function queryString(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      query.set(key, String(value));
    }
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

export class HubConnectionRequestClient {
  private readonly hubUrl: string;
  private readonly registration: HubRegistrationData;

  constructor(registration: HubRegistrationData) {
    this.hubUrl = registration.hubUrl.replace(/\/$/, "");
    this.registration = registration;
  }

  static createFromRegistration(): HubConnectionRequestClient {
    return new HubConnectionRequestClient(requireRegistration());
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
      throw new Error(`Hub connection request API error ${res.status}: ${JSON.stringify(body)}`);
    }

    return res.json() as Promise<T>;
  }

  private async bearerHeaders(): Promise<Record<string, string>> {
    try {
      const token = await getHubBearerToken(this.registration);
      return { Authorization: `Bearer ${token}` };
    } catch {
      return {};
    }
  }

  async listRequests(params: ListConnectionRequestsParams = {}): Promise<HubConnectionRequest[]> {
    return this.request<HubConnectionRequest[]>(`/api/connection-requests${queryString({
      q: optionalString(params.q),
      skill: optionalString(params.skill),
      requestType: optionalString(params.requestType),
      limit: params.limit,
    })}`);
  }

  async getRequest(requestId: number): Promise<HubConnectionRequest> {
    return this.request<HubConnectionRequest>(`/api/connection-requests/${requestId}`);
  }

  async createRequest(params: CreateConnectionRequestParams): Promise<HubConnectionRequest> {
    return this.request<HubConnectionRequest>("/api/connection-requests", {
      method: "POST",
      headers: await this.bearerHeaders(),
      body: JSON.stringify({
        ...identityPayload(this.registration),
        title: params.title,
        summary: params.summary,
        details: params.details ?? "",
        requestType: params.requestType,
        requiredSkills: params.requiredSkills ?? [],
        collaborationMode: params.collaborationMode,
        inputModes: params.inputModes ?? [],
        outputModes: params.outputModes ?? [],
        connectionHint: params.connectionHint,
        expiresAt: params.expiresAt,
      }),
    });
  }

  async listOffers(requestId: number): Promise<HubConnectionOffer[]> {
    return this.request<HubConnectionOffer[]>(`/api/connection-requests/${requestId}/offers`);
  }

  async createOffer(requestId: number, params: CreateConnectionOfferParams): Promise<HubConnectionOffer> {
    return this.request<HubConnectionOffer>(`/api/connection-requests/${requestId}/offers`, {
      method: "POST",
      headers: await this.bearerHeaders(),
      body: JSON.stringify({
        ...identityPayload(this.registration),
        message: params.message,
        skills: params.skills ?? [],
        collaborationMode: params.collaborationMode,
      }),
    });
  }

  async acceptOffer(offerId: number, params: AcceptConnectionOfferParams = {}): Promise<HubConnectionSession> {
    return this.request<HubConnectionSession>(`/api/connection-offers/${offerId}/accept`, {
      method: "POST",
      headers: await this.bearerHeaders(),
      body: JSON.stringify({
        ...identityPayload(this.registration),
        sharedContextRoomId: params.sharedContextRoomId,
      }),
    });
  }

  async getSession(sessionId: number): Promise<HubConnectionSession> {
    return this.request<HubConnectionSession>(`/api/connection-sessions/${sessionId}`);
  }
}

export function formatConnectionRequests(requests: HubConnectionRequest[]): string {
  if (requests.length === 0) {
    return "No open Hub connection requests found.";
  }

  return requests.map((request) => {
    const skills = (request.displaySkills?.length ? request.displaySkills : request.requiredSkills).join(", ");
    return [
      `- #${request.id} ${request.title}`,
      `  type=${request.requestType} mode=${request.collaborationMode} status=${request.status}`,
      request.requesterDisplayName ? `  requester=${request.requesterDisplayName}` : undefined,
      skills ? `  skills=[${skills}]` : undefined,
      `  summary=${request.summary}`,
    ].filter(Boolean).join("\n");
  }).join("\n");
}

export function formatConnectionOffers(offers: HubConnectionOffer[]): string {
  if (offers.length === 0) {
    return "No approved offers found for this request.";
  }

  return offers.map((offer) => {
    const skills = (offer.displaySkills?.length ? offer.displaySkills : offer.skills).join(", ");
    const protocols = offer.connectionProtocols?.join(", ");
    return [
      `- offer #${offer.id} from ${offer.responderName || offer.responderClientId || `agent-${offer.responderAgentId}`}`,
      `  status=${offer.status} mode=${offer.collaborationMode}`,
      skills ? `  skills=[${skills}]` : undefined,
      protocols ? `  protocols=[${protocols}]` : undefined,
      `  message=${offer.message}`,
    ].filter(Boolean).join("\n");
  }).join("\n");
}

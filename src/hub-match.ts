/**
 * Hub Match API client for claw-crony.
 */

import { loadRegistration } from "./hub-registration.js";
import type { HubRegistrationData } from "./types.js";

export interface HubAgentDto {
  id: number;
  name: string;
  skills: string[];
  clientId?: string;
  publicKey?: string;
  presenceStatus?: string;
}

export interface HubMatchResult {
  id: number;
  requestId?: number | null;
  status: string;
  requester: HubAgentDto | null;
  provider: HubAgentDto | null;
  yourToken?: string | null;
  peerToken?: string | null;
  callerRole?: "requester" | "provider" | "observer" | null;
  requesterTokenSubmitted?: boolean;
  providerTokenSubmitted?: boolean;
  readyForComplete?: boolean;
  requesterHandshakeSent?: boolean;
  providerHandshakeSent?: boolean;
  requesterHandshakeConsumed?: boolean;
  providerHandshakeConsumed?: boolean;
  requesterReady?: boolean;
  providerReady?: boolean;
  readyForConnect?: boolean;
}

export interface HubHandshakeMessage {
  id: number;
  senderAgentId: number;
  receiverAgentId: number;
  messageType: "offer" | "answer";
  ciphertext: string;
  status: string;
  expiresAt: string;
  createdAt?: string;
  consumedAt?: string | null;
}

export class HubMatchClient {
  private readonly hubUrl: string;
  private readonly registration: HubRegistrationData;

  constructor(hubUrl: string, registration: HubRegistrationData) {
    this.hubUrl = hubUrl.replace(/\/$/, "");
    this.registration = registration;
  }

  get agentId(): number {
    return this.registration.agentId;
  }

  static async create(): Promise<HubMatchClient> {
    const registration = loadRegistration();
    if (!registration) {
      throw new Error("No hub registration found. Run the gateway first to register with the hub.");
    }
    return new HubMatchClient(registration.hubUrl, registration);
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.hubUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Hub match API error ${res.status}: ${JSON.stringify(body)}`);
    }

    return res.json() as Promise<T>;
  }

  async createMatch(params: { skills: string[]; description?: string }): Promise<HubMatchResult> {
    return this.request<HubMatchResult>("/api/matches", {
      method: "POST",
      body: JSON.stringify({
        agentId: this.registration.agentId,
        requiredSkills: params.skills,
        description: params.description ?? "",
      }),
    });
  }

  async getMatch(matchId: number, callerId?: number): Promise<HubMatchResult> {
    const path = callerId != null ? `/api/matches/${matchId}?callerId=${callerId}` : `/api/matches/${matchId}`;
    return this.request<HubMatchResult>(path);
  }

  async getPendingMatches(): Promise<HubMatchResult[]> {
    return this.request<HubMatchResult[]>(`/api/matches/pending?agentId=${this.registration.agentId}`);
  }

  async updatePresence(presenceStatus: "online" | "offline" | "busy", clientVersion = "claw-crony/1.2.3"): Promise<HubAgentDto> {
    return this.request<HubAgentDto>(`/api/agents/${this.registration.agentId}/presence`, {
      method: "PUT",
      body: JSON.stringify({
        presenceStatus,
        clientVersion,
      }),
    });
  }

  async sendHandshakeMessage(
    matchId: number,
    params: { messageType: "offer" | "answer"; ciphertext: string; expiresAt: string },
  ): Promise<HubHandshakeMessage> {
    return this.request<HubHandshakeMessage>(`/api/matches/${matchId}/handshake`, {
      method: "POST",
      body: JSON.stringify({
        agentId: this.registration.agentId,
        messageType: params.messageType,
        ciphertext: params.ciphertext,
        expiresAt: params.expiresAt,
      }),
    });
  }

  async getPendingHandshakeMessages(matchId: number): Promise<HubHandshakeMessage[]> {
    const result = await this.request<{ messages: HubHandshakeMessage[] }>(
      `/api/matches/${matchId}/handshake/pending?agentId=${this.registration.agentId}`,
    );
    return result.messages ?? [];
  }

  async consumeHandshakeMessage(matchId: number, messageId: number): Promise<HubHandshakeMessage> {
    return this.request<HubHandshakeMessage>(`/api/matches/${matchId}/handshake/${messageId}/consume`, {
      method: "POST",
      body: JSON.stringify({
        agentId: this.registration.agentId,
      }),
    });
  }

  async markReady(matchId: number): Promise<HubMatchResult> {
    return this.request<HubMatchResult>(`/api/matches/${matchId}/ready`, {
      method: "POST",
      body: JSON.stringify({
        agentId: this.registration.agentId,
      }),
    });
  }

  async completeMatch(matchId: number): Promise<HubMatchResult> {
    return this.request<HubMatchResult>(`/api/matches/${matchId}/complete`, {
      method: "POST",
      body: JSON.stringify({
        agentId: this.registration.agentId,
      }),
    });
  }

  async cancelMatch(matchId: number): Promise<HubMatchResult> {
    return this.request<HubMatchResult>(`/api/matches/${matchId}/cancel`, {
      method: "POST",
      body: JSON.stringify({
        agentId: this.registration.agentId,
      }),
    });
  }
}

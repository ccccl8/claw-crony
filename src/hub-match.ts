/**
 * Hub Match API client for openclaw-a2a-gateway.
 *
 * Provides a typed client for the hub's /api/matches endpoints:
 * - POST   /api/matches              createMatch
 * - GET    /api/matches/{id}         getMatch
 * - GET    /api/matches/pending       getPendingMatches
 * - POST   /api/matches/{id}/token   submitToken
 * - POST   /api/matches/{id}/complete completeMatch
 * - POST   /api/matches/{id}/cancel  cancelMatch
 */

import { loadRegistration } from "./hub-registration.js";
import type { HubRegistrationData } from "./types.js";

// ---------------------------------------------------------------------------
// DTOs matching hub's MatchResponse
// ---------------------------------------------------------------------------

export interface HubAgentDto {
  id: number;
  name: string;
  address: string;
  skills: string[];
}

export interface HubMatchResult {
  id: number;
  status: string;
  requester: HubAgentDto | null;
  provider: HubAgentDto | null;
  yourToken: string | null;
  peerToken: string | null;
}

// ---------------------------------------------------------------------------
// HubMatchClient
// ---------------------------------------------------------------------------

export class HubMatchClient {
  private readonly hubUrl: string;
  private readonly registration: HubRegistrationData;

  constructor(hubUrl: string, registration: HubRegistrationData) {
    this.hubUrl = hubUrl.replace(/\/$/, "");
    this.registration = registration;
  }

  static async create(): Promise<HubMatchClient> {
    const registration = loadRegistration();
    if (!registration) {
      throw new Error("No hub registration found. Run the gateway first to register with the hub.");
    }
    const configUrl = registration.hubUrl;
    return new HubMatchClient(configUrl, registration);
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.hubUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.registration.token}`,
        ...(options.headers ?? {}),
      },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Hub match API error ${res.status}: ${JSON.stringify(body)}`);
    }

    return res.json() as Promise<T>;
  }

  /**
   * Create a new match request.
   * @param params.skills - Skills to search for in a provider
   * @param params.description - Optional description of the match request
   * @param params.token - Optional bearer token to include for this agent
   */
  async createMatch(params: {
    skills: string[];
    description?: string;
    token?: string;
  }): Promise<HubMatchResult> {
    return this.request<HubMatchResult>("/api/matches", {
      method: "POST",
      body: JSON.stringify({
        agentId: this.registration.agentId,
        requiredSkills: params.skills,
        description: params.description ?? "",
        token: params.token,
      }),
    });
  }

  /**
   * Get a match result by ID.
   * @param matchId - The match ID
   * @param callerId - Optional agent ID to set callerId query param (affects yourToken)
   */
  async getMatch(matchId: number, callerId?: number): Promise<HubMatchResult> {
    const path = callerId != null ? `/api/matches/${matchId}?callerId=${callerId}` : `/api/matches/${matchId}`;
    return this.request<HubMatchResult>(path);
  }

  /**
   * Get all pending matches for this agent.
   */
  async getPendingMatches(): Promise<HubMatchResult[]> {
    return this.request<HubMatchResult[]>(
      `/api/matches/pending?agentId=${this.registration.agentId}`
    );
  }

  /**
   * Submit this agent's token for a match.
   * @param matchId - The match ID
   * @param token - This agent's bearer token
   */
  async submitToken(matchId: number, token: string): Promise<HubMatchResult> {
    return this.request<HubMatchResult>(`/api/matches/${matchId}/token`, {
      method: "POST",
      body: JSON.stringify({
        agentId: this.registration.agentId,
        token,
      }),
    });
  }

  /**
   * Mark a match as completed (both parties have submitted tokens).
   * @param matchId - The match ID
   * @param token - This agent's bearer token (for authorization)
   */
  async completeMatch(matchId: number, token: string): Promise<HubMatchResult> {
    return this.request<HubMatchResult>(`/api/matches/${matchId}/complete`, {
      method: "POST",
      body: JSON.stringify({
        agentId: this.registration.agentId,
      }),
    });
  }

  /**
   * Cancel a pending or token_exchange match.
   * @param matchId - The match ID
   * @param token - This agent's bearer token (for authorization)
   */
  async cancelMatch(matchId: number, token: string): Promise<HubMatchResult> {
    return this.request<HubMatchResult>(`/api/matches/${matchId}/cancel`, {
      method: "POST",
      body: JSON.stringify({
        agentId: this.registration.agentId,
      }),
    });
  }
}

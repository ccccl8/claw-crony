import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ConnectionSessionView } from "./connection-session.js";
import type { HubConnectionOffer, HubConnectionRequest, HubConnectionSession } from "./hub-connection-requests.js";

const STATE_FILENAME = "claw-crony-connection-state.json";
const MAX_RECORDS = 100;

export interface CachedConnectionRequest {
  id: number;
  title: string;
  summary: string;
  requestType?: string;
  status?: string;
  moderationStatus?: string;
  createdAt?: string;
  cachedAt: string;
}

export interface CachedConnectionOffer {
  id: number;
  requestId: number;
  message: string;
  status?: string;
  moderationStatus?: string;
  createdAt?: string;
  cachedAt: string;
}

export interface CachedConnectionSession {
  id: number;
  requestId: number;
  offerId: number;
  status?: string;
  requesterClientId?: string | null;
  responderClientId?: string | null;
  recommendedMode?: "a2a" | "generic";
  protocols?: string[];
  a2aAgentCardUrl?: string;
  sharedContextRoomId?: string | null;
  createdAt?: string;
  cachedAt: string;
}

export interface ConnectionState {
  version: 1;
  updatedAt?: string;
  createdRequestIds: number[];
  createdOfferIds: number[];
  acceptedSessionIds: number[];
  requests: CachedConnectionRequest[];
  offers: CachedConnectionOffer[];
  sessions: CachedConnectionSession[];
}

function defaultState(): ConnectionState {
  return {
    version: 1,
    createdRequestIds: [],
    createdOfferIds: [],
    acceptedSessionIds: [],
    requests: [],
    offers: [],
    sessions: [],
  };
}

function defaultStatePath(): string {
  return path.join(os.homedir(), ".openclaw", STATE_FILENAME);
}

function uniqueNewest(ids: number[]): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(id);
  }
  return result.slice(0, MAX_RECORDS);
}

function upsertNewest<T extends { id: number }>(records: T[], next: T): T[] {
  return [next, ...records.filter((record) => record.id !== next.id)].slice(0, MAX_RECORDS);
}

function normalizeState(raw: unknown): ConnectionState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaultState();
  }
  const value = raw as Partial<ConnectionState>;
  return {
    version: 1,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
    createdRequestIds: uniqueNewest(Array.isArray(value.createdRequestIds) ? value.createdRequestIds : []),
    createdOfferIds: uniqueNewest(Array.isArray(value.createdOfferIds) ? value.createdOfferIds : []),
    acceptedSessionIds: uniqueNewest(Array.isArray(value.acceptedSessionIds) ? value.acceptedSessionIds : []),
    requests: Array.isArray(value.requests) ? value.requests.slice(0, MAX_RECORDS) : [],
    offers: Array.isArray(value.offers) ? value.offers.slice(0, MAX_RECORDS) : [],
    sessions: Array.isArray(value.sessions) ? value.sessions.slice(0, MAX_RECORDS) : [],
  };
}

export class ConnectionStateStore {
  private readonly filePath: string;

  constructor(filePath = defaultStatePath()) {
    this.filePath = filePath;
  }

  get path(): string {
    return this.filePath;
  }

  load(): ConnectionState {
    try {
      return normalizeState(JSON.parse(fs.readFileSync(this.filePath, "utf-8")));
    } catch {
      return defaultState();
    }
  }

  snapshot(): ConnectionState {
    return this.load();
  }

  recordRequest(request: HubConnectionRequest): ConnectionState {
    return this.update((state) => {
      const cachedAt = new Date().toISOString();
      state.createdRequestIds = uniqueNewest([request.id, ...state.createdRequestIds]);
      state.requests = upsertNewest(state.requests, {
        id: request.id,
        title: request.title,
        summary: request.summary,
        requestType: request.requestType,
        status: request.status,
        moderationStatus: request.moderationStatus,
        createdAt: request.createdAt,
        cachedAt,
      });
    });
  }

  recordOffer(offer: HubConnectionOffer): ConnectionState {
    return this.update((state) => {
      const cachedAt = new Date().toISOString();
      state.createdOfferIds = uniqueNewest([offer.id, ...state.createdOfferIds]);
      state.offers = upsertNewest(state.offers, {
        id: offer.id,
        requestId: offer.requestId,
        message: offer.message,
        status: offer.status,
        moderationStatus: offer.moderationStatus,
        createdAt: offer.createdAt,
        cachedAt,
      });
    });
  }

  recordSession(session: HubConnectionSession, view?: ConnectionSessionView): ConnectionState {
    return this.update((state) => {
      const cachedAt = new Date().toISOString();
      state.acceptedSessionIds = uniqueNewest([session.id, ...state.acceptedSessionIds]);
      state.sessions = upsertNewest(state.sessions, {
        id: session.id,
        requestId: session.requestId,
        offerId: session.offerId,
        status: session.status,
        requesterClientId: session.requesterClientId,
        responderClientId: session.responderClientId,
        recommendedMode: view?.recommendedMode,
        protocols: view?.generic.protocols,
        a2aAgentCardUrl: view?.a2a.agentCardUrl,
        sharedContextRoomId: session.sharedContextRoomId,
        createdAt: session.createdAt,
        cachedAt,
      });
    });
  }

  private update(mutator: (state: ConnectionState) => void): ConnectionState {
    const state = this.load();
    mutator(state);
    state.updatedAt = new Date().toISOString();
    this.save(state);
    return state;
  }

  private save(state: ConnectionState): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmpPath, this.filePath);
  }
}

export function formatConnectionState(state: ConnectionState): string {
  const requestLines = state.requests.length
    ? state.requests.map((request) => `- request #${request.id} [${request.status ?? "unknown"}] ${request.title}`).join("\n")
    : "- none";
  const offerLines = state.offers.length
    ? state.offers.map((offer) => `- offer #${offer.id} -> request #${offer.requestId} [${offer.status ?? "unknown"}] ${offer.message}`).join("\n")
    : "- none";
  const sessionLines = state.sessions.length
    ? state.sessions.map((session) => {
        const mode = session.recommendedMode ? ` mode=${session.recommendedMode}` : "";
        const peer = session.responderClientId ? ` responder=${session.responderClientId}` : "";
        return `- session #${session.id} request #${session.requestId} offer #${session.offerId}${mode}${peer}`;
      }).join("\n")
    : "- none";

  return [
    `Connection state updated: ${state.updatedAt ?? "(never)"}`,
    "",
    "Created requests:",
    requestLines,
    "",
    "Created offers:",
    offerLines,
    "",
    "Accepted/read sessions:",
    sessionLines,
  ].join("\n");
}

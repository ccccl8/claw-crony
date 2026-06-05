import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export type RequestHistoryType =
  | "match.created"
  | "match.failed"
  | "match.resolved"
  | "resolve.completed"
  | "resolve.failed"
  | "handshake.offer_sent"
  | "handshake.offer_received"
  | "handshake.answer_sent"
  | "handshake.answer_received"
  | "handshake.failed"
  | "peer.upserted"
  | "profile.synced"
  | "profile.sync_failed"
  | "profile.updated"
  | "profile.update_failed"
  | "send.started"
  | "send.completed"
  | "send.failed"
  | "send_file.started"
  | "send_file.completed"
  | "send_file.failed"
  | "official_agent.call_completed"
  | "official_agent.call_failed"
  | "shared.room_created"
  | "shared.room_archived"
  | "shared.message_posted"
  | "shared.artifact_attached"
  | "task.inbound_completed"
  | "task.inbound_failed";

export type RequestHistoryStatus = "started" | "success" | "failure" | "ignored";
export type RequestHistoryDirection = "inbound" | "outbound" | "local";

export interface RequestHistoryEntry {
  ts: string;
  type: RequestHistoryType;
  status: RequestHistoryStatus;
  direction?: RequestHistoryDirection;
  matchId?: number;
  messageId?: number;
  peer?: string;
  durationMs?: number;
  detail?: Record<string, unknown>;
}

export interface RequestHistoryFilter {
  count?: number;
  type?: string;
  status?: string;
  direction?: string;
  matchId?: number;
  peer?: string;
}

export interface RequestHistoryOptions {
  enabled: boolean;
  includeEncryptedPayloads: boolean;
}

const SECRET_KEY_NAMES = ["token", "secret", "password", "authorization", "ciphertext", "privatekey", "private_key"];

function redactValue(key: string, value: unknown, includeEncryptedPayloads: boolean): unknown {
  const normalizedKey = key.toLowerCase();
  if (SECRET_KEY_NAMES.some((name) => normalizedKey.includes(name))) {
    if (normalizedKey.includes("ciphertext") && includeEncryptedPayloads) {
      return value;
    }
    return "[redacted]";
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknown(entry, includeEncryptedPayloads));
  }

  if (value && typeof value === "object") {
    return redactObject(value as Record<string, unknown>, includeEncryptedPayloads);
  }

  return value;
}

function redactUnknown(value: unknown, includeEncryptedPayloads: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknown(entry, includeEncryptedPayloads));
  }

  if (value && typeof value === "object") {
    return redactObject(value as Record<string, unknown>, includeEncryptedPayloads);
  }

  return value;
}

function redactObject(value: Record<string, unknown>, includeEncryptedPayloads: boolean): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    next[key] = redactValue(key, entry, includeEncryptedPayloads);
  }
  return next;
}

function matchesFilter(entry: RequestHistoryEntry, filter: RequestHistoryFilter): boolean {
  if (filter.type && entry.type !== filter.type) return false;
  if (filter.status && entry.status !== filter.status) return false;
  if (filter.direction && entry.direction !== filter.direction) return false;
  if (filter.matchId != null && entry.matchId !== filter.matchId) return false;
  if (filter.peer && entry.peer !== filter.peer) return false;
  return true;
}

/**
 * Append-only request history store for operator-facing troubleshooting.
 * Unlike the audit log, this captures Hub match/handshake milestones and
 * gateway calls. Sensitive fields are redacted before persistence.
 */
export class RequestHistoryStore {
  private readonly filePath: string;
  private readonly options: RequestHistoryOptions;
  private dirEnsured = false;

  constructor(filePath: string, options: Partial<RequestHistoryOptions> = {}) {
    this.filePath = filePath;
    this.options = {
      enabled: options.enabled ?? true,
      includeEncryptedPayloads: options.includeEncryptedPayloads ?? false,
    };
  }

  record(entry: Omit<RequestHistoryEntry, "ts"> & { ts?: string }): void {
    if (!this.options.enabled) {
      return;
    }

    const detail = entry.detail
      ? redactObject(entry.detail, this.options.includeEncryptedPayloads)
      : undefined;
    this.write({
      ...entry,
      ts: entry.ts ?? new Date().toISOString(),
      ...(detail ? { detail } : {}),
    });
  }

  async tail(filter: RequestHistoryFilter = {}): Promise<RequestHistoryEntry[]> {
    if (!fs.existsSync(this.filePath)) return [];

    const count = Math.min(Math.max(1, Math.floor(filter.count ?? 50)), 500);
    const entries: RequestHistoryEntry[] = [];
    const input = fs.createReadStream(this.filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as RequestHistoryEntry;
        if (matchesFilter(entry, filter)) {
          entries.push(entry);
        }
      } catch {
        // Skip malformed lines.
      }
    }

    return entries.slice(-count).reverse();
  }

  close(): void {
    // No persistent handles.
  }

  private ensureDir(): void {
    if (this.dirEnsured) return;
    this.dirEnsured = true;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  private write(entry: RequestHistoryEntry): void {
    try {
      this.ensureDir();
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
    } catch {
      // History is diagnostic only; never crash the gateway.
    }
  }
}

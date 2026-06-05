import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export type SharedRoomStatus = "open" | "archived";
export type SharedMessageKind =
  | "text"
  | "markdown"
  | "code"
  | "diff"
  | "status_update"
  | "summary"
  | "question"
  | "decision"
  | "blocker"
  | "artifact_ref";

export interface SharedArtifactRef {
  id: string;
  roomId: string;
  messageId?: string;
  kind: string;
  name?: string;
  uri?: string;
  mimeType?: string;
  digest?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  createdBy: string;
}

export interface SharedRoom {
  id: string;
  title: string;
  topic?: string;
  participants: string[];
  tags: string[];
  status: SharedRoomStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  metadata?: Record<string, unknown>;
}

export interface SharedMessage {
  id: string;
  roomId: string;
  ts: string;
  author: string;
  kind: SharedMessageKind;
  content: string;
  artifacts?: SharedArtifactRef[];
  metadata?: Record<string, unknown>;
}

export interface SharedRoomFilter {
  count?: number;
  participant?: string;
  status?: SharedRoomStatus;
  tag?: string;
}

export interface SharedMessageFilter {
  count?: number;
  after?: string;
}

type SharedEvent =
  | { type: "room.created"; ts: string; room: SharedRoom }
  | { type: "room.updated"; ts: string; room: SharedRoom }
  | { type: "message.posted"; ts: string; message: SharedMessage }
  | { type: "artifact.attached"; ts: string; artifact: SharedArtifactRef };

export interface SharedContextStoreOptions {
  enabled: boolean;
  maxMessageChars: number;
  maxMessagesPerRead: number;
}

interface SharedState {
  rooms: Map<string, SharedRoom>;
  messages: Map<string, SharedMessage[]>;
  artifacts: Map<string, SharedArtifactRef[]>;
}

const DEFAULT_MAX_MESSAGE_CHARS = 20_000;
const DEFAULT_MAX_MESSAGES_PER_READ = 100;

export class SharedContextStore {
  private readonly filePath: string;
  private readonly options: SharedContextStoreOptions;
  private dirEnsured = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string, options: Partial<SharedContextStoreOptions> = {}) {
    this.filePath = path.resolve(filePath);
    this.options = {
      enabled: options.enabled ?? true,
      maxMessageChars: Math.max(1, Math.floor(options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS)),
      maxMessagesPerRead: Math.max(1, Math.floor(options.maxMessagesPerRead ?? DEFAULT_MAX_MESSAGES_PER_READ)),
    };
  }

  async createRoom(input: {
    title: string;
    topic?: string;
    participants?: string[];
    tags?: string[];
    createdBy?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SharedRoom> {
    this.requireEnabled();
    const now = new Date().toISOString();
    const room: SharedRoom = {
      id: `room-${crypto.randomUUID()}`,
      title: requireText(input.title, "title"),
      topic: optionalText(input.topic),
      participants: normalizeStringList(input.participants),
      tags: normalizeStringList(input.tags).map((tag) => tag.toLowerCase()),
      status: "open",
      createdAt: now,
      updatedAt: now,
      createdBy: optionalText(input.createdBy) || "unknown",
      metadata: normalizeMetadata(input.metadata),
    };
    await this.append({ type: "room.created", ts: now, room });
    return room;
  }

  async listRooms(filter: SharedRoomFilter = {}): Promise<SharedRoom[]> {
    this.requireEnabled();
    const state = await this.loadState();
    const count = normalizeCount(filter.count, 50, 500);
    const rooms = Array.from(state.rooms.values())
      .filter((room) => !filter.status || room.status === filter.status)
      .filter((room) => !filter.participant || room.participants.includes(filter.participant))
      .filter((room) => !filter.tag || room.tags.includes(filter.tag.toLowerCase()))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return rooms.slice(0, count);
  }

  async getRoom(roomId: string): Promise<SharedRoom | null> {
    this.requireEnabled();
    const state = await this.loadState();
    return state.rooms.get(roomId) ?? null;
  }

  async archiveRoom(roomId: string): Promise<SharedRoom> {
    this.requireEnabled();
    const state = await this.loadState();
    const room = state.rooms.get(roomId);
    if (!room) {
      throw new Error(`shared room not found: ${roomId}`);
    }

    const now = new Date().toISOString();
    const archivedRoom: SharedRoom = {
      ...room,
      status: "archived",
      updatedAt: now,
    };
    await this.append({ type: "room.updated", ts: now, room: archivedRoom });
    return archivedRoom;
  }

  async postMessage(input: {
    roomId: string;
    author: string;
    content: string;
    kind?: SharedMessageKind;
    artifacts?: Array<Omit<SharedArtifactRef, "id" | "roomId" | "messageId" | "createdAt" | "createdBy">>;
    metadata?: Record<string, unknown>;
  }): Promise<SharedMessage> {
    this.requireEnabled();
    const state = await this.loadState();
    const room = state.rooms.get(input.roomId);
    if (!room) {
      throw new Error(`shared room not found: ${input.roomId}`);
    }
    if (room.status === "archived") {
      throw new Error(`shared room is archived: ${input.roomId}`);
    }

    const now = new Date().toISOString();
    const content = requireContentText(input.content, "content");
    if (content.length > this.options.maxMessageChars) {
      throw new Error(`content exceeds maxMessageChars=${this.options.maxMessageChars}`);
    }

    const messageId = `msg-${crypto.randomUUID()}`;
    const author = optionalText(input.author) || "unknown";
    const artifacts = (input.artifacts ?? []).map((artifact) => normalizeArtifactRef({
      ...artifact,
      id: `artifact-${crypto.randomUUID()}`,
      roomId: input.roomId,
      messageId,
      createdAt: now,
      createdBy: author,
    }));
    const message: SharedMessage = {
      id: messageId,
      roomId: input.roomId,
      ts: now,
      author,
      kind: normalizeMessageKind(input.kind),
      content,
      ...(artifacts.length ? { artifacts } : {}),
      metadata: normalizeMetadata(input.metadata),
    };
    const updatedRoom = { ...room, updatedAt: now };

    await this.appendMany([
      { type: "message.posted", ts: now, message },
      ...artifacts.map((artifact): SharedEvent => ({ type: "artifact.attached", ts: now, artifact })),
      { type: "room.updated", ts: now, room: updatedRoom },
    ]);
    return message;
  }

  async readMessages(roomId: string, filter: SharedMessageFilter = {}): Promise<SharedMessage[]> {
    this.requireEnabled();
    const state = await this.loadState();
    if (!state.rooms.has(roomId)) {
      throw new Error(`shared room not found: ${roomId}`);
    }
    const count = normalizeCount(filter.count, 50, this.options.maxMessagesPerRead);
    let messages = state.messages.get(roomId) ?? [];
    if (filter.after) {
      messages = messages.filter((message) => message.ts > filter.after!);
    }
    return messages.slice(-count);
  }

  async attachArtifact(input: {
    roomId: string;
    messageId?: string;
    createdBy?: string;
    kind: string;
    name?: string;
    uri?: string;
    mimeType?: string;
    digest?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SharedArtifactRef> {
    this.requireEnabled();
    const state = await this.loadState();
    const room = state.rooms.get(input.roomId);
    if (!room) {
      throw new Error(`shared room not found: ${input.roomId}`);
    }
    if (room.status === "archived") {
      throw new Error(`shared room is archived: ${input.roomId}`);
    }
    if (input.messageId && !(state.messages.get(input.roomId) ?? []).some((message) => message.id === input.messageId)) {
      throw new Error(`shared message not found in room ${input.roomId}: ${input.messageId}`);
    }

    const now = new Date().toISOString();
    const artifact = normalizeArtifactRef({
      id: `artifact-${crypto.randomUUID()}`,
      roomId: input.roomId,
      messageId: optionalText(input.messageId) || undefined,
      kind: requireText(input.kind, "kind"),
      name: optionalText(input.name) || undefined,
      uri: optionalText(input.uri) || undefined,
      mimeType: optionalText(input.mimeType) || undefined,
      digest: optionalText(input.digest) || undefined,
      metadata: normalizeMetadata(input.metadata),
      createdAt: now,
      createdBy: optionalText(input.createdBy) || "unknown",
    });
    await this.append({ type: "artifact.attached", ts: now, artifact });
    return artifact;
  }

  async summarizeRoom(roomId: string, count = 20): Promise<{
    room: SharedRoom;
    messageCount: number;
    artifactCount: number;
    participants: string[];
    recent: SharedMessage[];
    blockers: SharedMessage[];
    decisions: SharedMessage[];
  }> {
    this.requireEnabled();
    const state = await this.loadState();
    const room = state.rooms.get(roomId);
    if (!room) {
      throw new Error(`shared room not found: ${roomId}`);
    }
    const messages = state.messages.get(roomId) ?? [];
    const artifacts = state.artifacts.get(roomId) ?? [];
    const participants = Array.from(new Set([...room.participants, ...messages.map((message) => message.author)])).sort();
    return {
      room,
      messageCount: messages.length,
      artifactCount: artifacts.length,
      participants,
      recent: messages.slice(-normalizeCount(count, 20, this.options.maxMessagesPerRead)),
      blockers: messages.filter((message) => message.kind === "blocker").slice(-10),
      decisions: messages.filter((message) => message.kind === "decision").slice(-10),
    };
  }

  close(): void {
    // No persistent handles.
  }

  private requireEnabled(): void {
    if (!this.options.enabled) {
      throw new Error("shared context is disabled");
    }
  }

  private async append(event: SharedEvent): Promise<void> {
    await this.appendMany([event]);
  }

  private async appendMany(events: SharedEvent[]): Promise<void> {
    this.ensureDir();
    const payload = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    const write = this.writeQueue.then(() => fs.promises.appendFile(this.filePath, payload, "utf8"));
    this.writeQueue = write.catch(() => {});
    await write;
  }

  private ensureDir(): void {
    if (this.dirEnsured) return;
    this.dirEnsured = true;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  private async loadState(): Promise<SharedState> {
    const state: SharedState = {
      rooms: new Map(),
      messages: new Map(),
      artifacts: new Map(),
    };
    if (!fs.existsSync(this.filePath)) {
      return state;
    }

    const input = fs.createReadStream(this.filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        applyEvent(state, JSON.parse(line) as SharedEvent);
      } catch {
        // Shared context is operator-facing; skip malformed lines.
      }
    }
    return state;
  }
}

function applyEvent(state: SharedState, event: SharedEvent): void {
  if (event.type === "room.created" || event.type === "room.updated") {
    state.rooms.set(event.room.id, event.room);
    return;
  }
  if (event.type === "message.posted") {
    const messages = state.messages.get(event.message.roomId) ?? [];
    messages.push(event.message);
    state.messages.set(event.message.roomId, messages);
    return;
  }
  if (event.type === "artifact.attached") {
    const artifacts = state.artifacts.get(event.artifact.roomId) ?? [];
    artifacts.push(event.artifact);
    state.artifacts.set(event.artifact.roomId, artifacts);
  }
}

function normalizeCount(value: unknown, fallback: number, max: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(Math.max(1, Math.floor(value)), max);
  }
  return Math.min(Math.max(1, fallback), max);
}

function requireText(value: unknown, name: string): string {
  const text = optionalText(value);
  if (!text) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return text;
}

function requireContentText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)));
}

function normalizeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const metadata = value as Record<string, unknown>;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function normalizeMessageKind(kind: unknown): SharedMessageKind {
  const value = optionalText(kind);
  const allowed: SharedMessageKind[] = [
    "text",
    "markdown",
    "code",
    "diff",
    "status_update",
    "summary",
    "question",
    "decision",
    "blocker",
    "artifact_ref",
  ];
  return (allowed as string[]).includes(value) ? value as SharedMessageKind : "markdown";
}

function normalizeArtifactRef(value: SharedArtifactRef): SharedArtifactRef {
  if (!value.uri && !value.digest && !value.name) {
    throw new Error("artifact must include at least one of uri, digest, or name");
  }
  return {
    id: value.id,
    roomId: value.roomId,
    messageId: value.messageId,
    kind: requireText(value.kind, "artifact.kind"),
    name: value.name,
    uri: value.uri,
    mimeType: value.mimeType,
    digest: value.digest,
    metadata: value.metadata,
    createdAt: value.createdAt,
    createdBy: value.createdBy,
  };
}

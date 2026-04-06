/**
 * A2A Gateway plugin endpoints:
 * - /.well-known/agent.json  (Agent Card discovery)
 * - /a2a/jsonrpc              (JSON-RPC transport)
 * - /a2a/rest                 (REST transport)
 * - gRPC on port+1            (gRPC transport)
 */

import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { DefaultRequestHandler } from "@a2a-js/sdk/server";
import { UserBuilder, agentCardHandler, jsonRpcHandler, restHandler } from "@a2a-js/sdk/server/express";
import { grpcService, A2AService, UserBuilder as GrpcUserBuilder } from "@a2a-js/sdk/server/grpc";
import { Server as GrpcServer, ServerCredentials, status as GrpcStatus } from "@grpc/grpc-js";
import express from "express";

import { buildAgentCard } from "./src/agent-card.js";
import { A2AClient } from "./src/client.js";
import { OpenClawAgentExecutor } from "./src/executor.js";
import { QueueingAgentExecutor } from "./src/queueing-executor.js";
import { runTaskCleanup } from "./src/task-cleanup.js";
import { FileTaskStore } from "./src/task-store.js";
import { GatewayTelemetry } from "./src/telemetry.js";
import { AuditLogger } from "./src/audit.js";
import { PeerHealthManager } from "./src/peer-health.js";
import { runHubRegistration } from "./src/hub-registration.js";
import { HubMatchClient, type HubMatchResult } from "./src/hub-match.js";
import { normalizeAgentCardSkills } from "./src/skill-catalog.js";
import { parseRoutingRules, matchRule } from "./src/routing-rules.js";
import { isRetryableTransportError } from "./src/transport-fallback.js";
import type { RoutingRule } from "./src/types.js";
import type {
  AgentCardConfig,
  AgentSkillConfig,
  GatewayConfig,
  HubConfig,
  InboundAuth,
  OpenClawPluginApi,
  PeerConfig,
  RegistrationConfig,
} from "./src/types.js";
import {
  validateUri,
  validateMimeType,
} from "./src/file-security.js";

/** Build a JSON-RPC error response. */
function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }

  return fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  return fallback;
}

function normalizeHttpPath(value: string, fallback: string): string {
  const trimmed = value.trim() || fallback;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function resolveConfiguredPath(
  value: unknown,
  fallback: string,
  resolvePath?: (nextPath: string) => string,
): string {
  const configured = asString(value, "").trim() || fallback;
  const resolved = resolvePath ? resolvePath(configured) : configured;
  return path.isAbsolute(resolved) ? resolved : path.resolve(resolved);
}

/** Extract skill names from an Agent Card object (used for routing-rules skill matching). */
function extractSkillsFromAgentCard(card: Record<string, unknown>): string[] {
  const skills = card.skills;
  if (!Array.isArray(skills)) return [];
  return skills.map((s) => (typeof s === "string" ? s : (asObject(s).name as string) ?? "")).filter(Boolean);
}

function parseAgentCard(raw: Record<string, unknown>): AgentCardConfig {
  const skills = normalizeAgentCardSkills(Array.isArray(raw.skills) ? raw.skills as Array<AgentSkillConfig | string> : []);

  return {
    name: asString(raw.name, "OpenClaw A2A Gateway"),
    description: asString(raw.description, "A2A bridge for OpenClaw agents"),
    url: asString(raw.url, ""),
    skills: skills.map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      const skill = asObject(entry);
      return {
        id: asString(skill.id, ""),
        name: asString(skill.name, "unknown"),
        description: asString(skill.description, ""),
      };
    }),
  };
}

function parsePeers(raw: unknown): PeerConfig[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const peers: PeerConfig[] = [];
  for (const entry of raw) {
    const value = asObject(entry);
    const name = asString(value.name, "");
    const agentCardUrl = asString(value.agentCardUrl, "");
    if (!name || !agentCardUrl) {
      continue;
    }

    const authRaw = asObject(value.auth);
    const authTypeRaw = asString(authRaw.type, "");
    const authType = authTypeRaw === "bearer" || authTypeRaw === "apiKey" ? authTypeRaw : "";
    const token = asString(authRaw.token, "");

    peers.push({
      name,
      agentCardUrl,
      auth: authType && token ? { type: authType, token } : undefined,
    });
  }

  return peers;
}

export function parseConfig(raw: unknown, resolvePath?: (nextPath: string) => string): GatewayConfig {
  const config = asObject(raw);
  const server = asObject(config.server);
  const storage = asObject(config.storage);
  const security = asObject(config.security);
  const routing = asObject(config.routing);
  const limits = asObject(config.limits);
  const observability = asObject(config.observability);
  const timeouts = asObject(config.timeouts);
  const resilience = asObject(config.resilience);
  const healthCheck = asObject(resilience.healthCheck);
  const retry = asObject(resilience.retry);
  const circuitBreaker = asObject(resilience.circuitBreaker);
  const hub = asObject(config.hub);
  const registration = asObject(config.registration);

  const inboundAuth = asString(security.inboundAuth, "none") as InboundAuth;

  const defaultMimeTypes = [
    "image/*", "application/pdf", "text/plain", "text/csv",
    "application/json", "audio/*", "video/*",
  ];
  const rawAllowedMime = Array.isArray(security.allowedMimeTypes) ? security.allowedMimeTypes : [];
  const allowedMimeTypes = rawAllowedMime.length > 0
    ? rawAllowedMime.filter((v: unknown) => typeof v === "string") as string[]
    : defaultMimeTypes;
  const rawUriAllowlist = Array.isArray(security.fileUriAllowlist) ? security.fileUriAllowlist : [];
  const fileUriAllowlist = rawUriAllowlist.filter((v: unknown) => typeof v === "string") as string[];

  return {
    agentCard: parseAgentCard(asObject(config.agentCard)),
    server: {
      host: asString(server.host, "0.0.0.0"),
      port: asNumber(server.port, 18800),
    },
    storage: {
      tasksDir: resolveConfiguredPath(
        storage.tasksDir,
        path.join(os.homedir(), ".openclaw", "a2a-tasks"),
        resolvePath,
      ),
      taskTtlHours: Math.max(1, asNumber(storage.taskTtlHours, 72)),
      cleanupIntervalMinutes: Math.max(1, asNumber(storage.cleanupIntervalMinutes, 60)),
    },
    peers: parsePeers(config.peers),
    security: (() => {
      const singleToken = asString(security.token, "");
      const tokenArray = Array.isArray(security.tokens)
        ? (security.tokens as unknown[]).filter((t): t is string => typeof t === "string" && t.length > 0)
        : [];
      const validTokens = new Set<string>(
        [singleToken, ...tokenArray].filter(t => t.length > 0),
      );
      return {
        inboundAuth: inboundAuth === "bearer" ? "bearer" : "none" as const,
        token: singleToken,
        tokens: tokenArray,
        validTokens,
        allowedMimeTypes,
        maxFileSizeBytes: asNumber(security.maxFileSizeBytes, 52_428_800),
        maxInlineFileSizeBytes: asNumber(security.maxInlineFileSizeBytes, 10_485_760),
        fileUriAllowlist,
      };
    })(),
    routing: {
      defaultAgentId: asString(routing.defaultAgentId, "default"),
      rules: parseRoutingRules(routing.rules),
    },
    limits: {
      maxConcurrentTasks: Math.max(1, Math.floor(asNumber(limits.maxConcurrentTasks, 4))),
      maxQueuedTasks: Math.max(0, Math.floor(asNumber(limits.maxQueuedTasks, 100))),
    },
    observability: {
      structuredLogs: asBoolean(observability.structuredLogs, true),
      exposeMetricsEndpoint: asBoolean(observability.exposeMetricsEndpoint, true),
      metricsPath: normalizeHttpPath(asString(observability.metricsPath, "/a2a/metrics"), "/a2a/metrics"),
      metricsAuth: (asString(observability.metricsAuth, "none") === "bearer" ? "bearer" : "none") as "none" | "bearer",
      auditLogPath: resolveConfiguredPath(
        observability.auditLogPath,
        path.join(os.homedir(), ".openclaw", "a2a-audit.jsonl"),
        resolvePath,
      ),
    },
    timeouts: {
      agentResponseTimeoutMs: asNumber(timeouts.agentResponseTimeoutMs, 300_000),
    },
    resilience: {
      healthCheck: {
        enabled: asBoolean(healthCheck.enabled, true),
        intervalMs: asNumber(healthCheck.intervalMs, 30_000),
        timeoutMs: asNumber(healthCheck.timeoutMs, 5_000),
      },
      retry: {
        maxRetries: Math.max(0, Math.floor(asNumber(retry.maxRetries, 3))),
        baseDelayMs: asNumber(retry.baseDelayMs, 1_000),
        maxDelayMs: asNumber(retry.maxDelayMs, 10_000),
      },
      circuitBreaker: {
        failureThreshold: Math.max(1, Math.floor(asNumber(circuitBreaker.failureThreshold, 5))),
        resetTimeoutMs: asNumber(circuitBreaker.resetTimeoutMs, 30_000),
      },
    },
    hub: {
      url: asString(hub.url, "https://www.factormining.cn"),
      enabled: asBoolean(hub.enabled, true),
      registrationEnabled: asBoolean(hub.registrationEnabled, true),
    },
    registration: {
      username: asString(registration.username, ""),
      email: asString(registration.email, ""),
      password: asString(registration.password, ""),
    },
  };
}

function normalizeCardPath(): string {
  if (AGENT_CARD_PATH.startsWith("/")) {
    return AGENT_CARD_PATH;
  }

  return `/${AGENT_CARD_PATH}`;
}

function getAdvertisedInboundToken(config: GatewayConfig, hubClient?: HubMatchClient | null): string | null {
  if (config.security.tokens && config.security.tokens.length > 0) {
    return config.security.tokens[0] ?? null;
  }

  if (config.security.token) {
    return config.security.token;
  }

  return hubClient?.registrationToken ?? null;
}

async function processPendingHubMatches(
  api: OpenClawPluginApi,
  config: GatewayConfig,
  processedMatches: Set<number>,
) {
  let hubClient: HubMatchClient;
  try {
    hubClient = await HubMatchClient.create();
  } catch (err) {
    api.logger.warn(`claw-crony: pending match polling skipped - ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const inboundToken = getAdvertisedInboundToken(config, hubClient);
  if (!inboundToken) {
    api.logger.warn("claw-crony: pending match polling skipped - no inbound token available");
    return;
  }

  let matches: HubMatchResult[];
  try {
    matches = await hubClient.getPendingMatches();
  } catch (err) {
    api.logger.warn(`claw-crony: failed to fetch pending matches - ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  for (const match of matches) {
    if (match.callerRole !== "provider") {
      continue;
    }

    try {
      const alreadySubmitted = match.providerTokenSubmitted === true || processedMatches.has(match.id);
      let currentMatch = match;

      if (!alreadySubmitted) {
        currentMatch = await hubClient.submitToken(match.id, inboundToken);
        processedMatches.add(match.id);
        api.logger.info(`claw-crony: submitted provider token for hub match ${match.id}`);
      }

      if (currentMatch.readyForComplete === true && currentMatch.status === "token_exchange") {
        await hubClient.completeMatch(match.id, inboundToken);
        processedMatches.delete(match.id);
        api.logger.info(`claw-crony: completed hub match ${match.id}`);
      }
    } catch (err) {
      api.logger.warn(`claw-crony: failed to process hub match ${match.id} - ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

const plugin = {
  id: "claw-crony",
  name: "Claw Crony",
  description: "OpenClaw plugin that serves A2A v0.3.0 endpoints",

  register(api: OpenClawPluginApi) {
    const config = parseConfig(api.pluginConfig, api.resolvePath?.bind(api));
    const telemetry = new GatewayTelemetry(api.logger, {
      structuredLogs: config.observability.structuredLogs,
    });
    const auditLogger = new AuditLogger(config.observability.auditLogPath);
    const client = new A2AClient();
    const taskStore = new FileTaskStore(config.storage.tasksDir);
    const executor = new QueueingAgentExecutor(
      new OpenClawAgentExecutor(api, config),
      telemetry,
      config.limits,
    );
    const agentCard = buildAgentCard(config);

    // Peer resilience: health check + circuit breaker
    const healthManager = config.peers.length > 0
      ? new PeerHealthManager(
          config.peers,
          config.resilience.healthCheck,
          config.resilience.circuitBreaker,
          async (peer) => {
            try {
              const card = await client.discoverAgentCard(peer, config.resilience.healthCheck.timeoutMs) as Record<string, unknown>;
              // Cache peer's skills for routing-rules skill matching
              const skills = extractSkillsFromAgentCard(card);
              healthManager!.setPeerSkills(peer.name, skills);
              return true;
            } catch {
              return false;
            }
          },
          (level, msg, details) => {
            if (level === "error") {
              api.logger.error(details ? `${msg}: ${JSON.stringify(details)}` : msg);
            } else if (level === "warn") {
              api.logger.warn(details ? `${msg}: ${JSON.stringify(details)}` : msg);
            } else {
              api.logger.info(details ? `${msg}: ${JSON.stringify(details)}` : msg);
            }
          },
        )
      : null;

    // Wire peer state into telemetry snapshot
    if (healthManager) {
      telemetry.setPeerStateProvider(() => healthManager.getAllStates());
    }

    // Wire audit logger for inbound task completion
    telemetry.setTaskAuditCallback((taskId, contextId, state, durationMs) => {
      auditLogger.recordInbound(taskId, contextId, state, durationMs);
    });

    // SDK expects userBuilder(req) -> Promise<User>
    // When bearer auth is configured, validate the Authorization header.
    const userBuilder = async (req: { headers?: Record<string, string | string[] | undefined> }) => {
      if (config.security.inboundAuth === "bearer" && config.security.validTokens.size > 0) {
        const authHeader = req.headers?.authorization;
        const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
        const providedToken = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
        if (!providedToken || !config.security.validTokens.has(providedToken)) {
          telemetry.recordSecurityRejection("http", "invalid or missing bearer token");
          auditLogger.recordSecurityEvent("http", "invalid or missing bearer token");
          throw jsonRpcError(null, -32000, "Unauthorized: invalid or missing bearer token");
        }
      }
      return UserBuilder.noAuthentication();
    };

    const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);

    const app = express();
    const createHttpMetricsMiddleware =
      (route: "jsonrpc" | "rest" | "metrics") =>
      (_req: express.Request, res: express.Response, next: express.NextFunction) => {
        const startedAt = Date.now();
        res.on("finish", () => {
          telemetry.recordInboundHttp(route, res.statusCode, Date.now() - startedAt);
        });
        next();
      };

    const cardPath = normalizeCardPath();
    const cardEndpointHandler = agentCardHandler({ agentCardProvider: requestHandler });

    app.use(cardPath, cardEndpointHandler);
    if (cardPath != "/.well-known/agent.json") {
      app.use("/.well-known/agent.json", cardEndpointHandler);
    }

    app.use(
      "/a2a/jsonrpc",
      createHttpMetricsMiddleware("jsonrpc"),
      jsonRpcHandler({
        requestHandler,
        userBuilder,
      })
    );

    // Ensure errors return JSON-RPC style responses (avoid Express HTML error pages)
    app.use("/a2a/jsonrpc", (err: unknown, _req: unknown, res: any, next: (e?: unknown) => void) => {
      if (err instanceof SyntaxError) {
        res.status(400).json(jsonRpcError(null, -32700, "Parse error"));
        return;
      }

      // Surface A2A-specific errors with proper codes
      const a2aErr = err as { code?: number; message?: string; taskId?: string } | undefined;
      if (a2aErr && typeof a2aErr.code === "number") {
        const status = a2aErr.code === -32601 ? 404 : 400;
        res.status(status).json(jsonRpcError(null, a2aErr.code, a2aErr.message || "Unknown error"));
        return;
      }

      // Generic internal error
      res.status(500).json(jsonRpcError(null, -32603, "Internal error"));
    });

    app.use(
      "/a2a/rest",
      createHttpMetricsMiddleware("rest"),
      restHandler({
        requestHandler,
        userBuilder,
      })
    );

    if (config.observability.exposeMetricsEndpoint) {
      app.get(
        config.observability.metricsPath,
        createHttpMetricsMiddleware("metrics"),
        (req, res, next) => {
          if (config.observability.metricsAuth === "bearer" && config.security.validTokens.size > 0) {
            const authHeader = req.headers.authorization;
            const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
            const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
            if (!token || !config.security.validTokens.has(token)) {
              res.status(401).json({ error: "Unauthorized: invalid or missing bearer token" });
              return;
            }
          }
          next();
        },
        (_req, res) => {
          res.json(telemetry.snapshot());
        },
      );
    }

    let server: Server | null = null;
    let grpcServer: GrpcServer | null = null;
    let cleanupTimer: ReturnType<typeof setInterval> | null = null;
    let hubMatchPollingTimer: ReturnType<typeof setInterval> | null = null;
    const grpcPort = config.server.port + 1;
    const processedHubMatches = new Set<number>();

    api.registerGatewayMethod("a2a.metrics", ({ respond }) => {
      respond(true, {
        metrics: telemetry.snapshot(),
      });
    });

    api.registerGatewayMethod("a2a.audit", ({ params, respond }) => {
      const payload = asObject(params);
      const count = Math.min(Math.max(1, asNumber(payload.count, 50)), 500);
      auditLogger
        .tail(count)
        .then((entries) => respond(true, { entries, count: entries.length }))
        .catch((error) => respond(false, { error: String(error?.message || error) }));
    });

    api.registerGatewayMethod("a2a.send", ({ params, respond }) => {
      const payload = asObject(params);
      const peerName = asString(payload.peer || payload.name, "");
      const message = asObject(payload.message || payload.payload);

      // Determine target peer: explicit name > routing rules > error
      let resolvedPeerName = peerName;
      let resolvedAgentId: string | undefined;

      if (!resolvedPeerName && config.routing.rules && config.routing.rules.length > 0) {
        const messageText = asString(message.text || message.message || "", "");
        const messageTags = Array.isArray((message as any).tags) ? ((message as any).tags as string[]) : undefined;
        const peerSkills = healthManager?.getPeerSkills();
        const routingMatch = matchRule(
          config.routing.rules,
          { text: messageText, tags: messageTags },
          peerSkills,
        );
        if (routingMatch) {
          resolvedPeerName = routingMatch.peer;
          resolvedAgentId = routingMatch.agentId;
          api.logger.info(`routing.match: "${resolvedPeerName}" via rule (agentId=${resolvedAgentId ?? "default"})`);
        }
      }

      const peer = config.peers.find((candidate) => candidate.name === resolvedPeerName);
      if (!peer) {
        respond(false, { error: `Peer not found: ${resolvedPeerName || "(none)"}` });
        return;
      }

      // Apply routing-rule agentId if not already set on the message
      if (resolvedAgentId && !(message as any).agentId) {
        (message as any).agentId = resolvedAgentId;
      }

      const startedAt = Date.now();
      const sendOptions = {
        healthManager: healthManager ?? undefined,
        retryConfig: config.resilience.retry,
        log: (level: "info" | "warn", msg: string, details?: Record<string, unknown>) => {
          if (details?.attempt) {
            telemetry.recordPeerRetry(peer.name, details.attempt as number);
          }
          api.logger[level](details ? `${msg}: ${JSON.stringify(details)}` : msg);
        },
      };
      client
        .sendMessage(peer, message, sendOptions)
        .then((result) => {
          const outDuration = Date.now() - startedAt;
          telemetry.recordOutboundRequest(peer.name, result.ok, result.statusCode, outDuration);
          auditLogger.recordOutbound(peer.name, result.ok, result.statusCode, outDuration);
          if (result.ok) {
            respond(true, {
              statusCode: result.statusCode,
              response: result.response,
            });
            return;
          }

          respond(false, {
            statusCode: result.statusCode,
            response: result.response,
          });
        })
        .catch((error) => {
          const errDuration = Date.now() - startedAt;
          telemetry.recordOutboundRequest(peer.name, false, 500, errDuration);
          auditLogger.recordOutbound(peer.name, false, 500, errDuration);
          respond(false, { error: String(error?.message || error) });
        });
    });

    // ------------------------------------------------------------------
    // Agent tool: a2a_send_file
    // Lets the agent send a file (by URI) to a peer via A2A FilePart.
    // ------------------------------------------------------------------
    if (api.registerTool) {
      const sendFileParams = {
        type: "object" as const,
        required: ["peer", "uri"],
        properties: {
          peer: { type: "string" as const, description: "Name of the target peer (must match a configured peer name)" },
          uri: { type: "string" as const, description: "Public URL of the file to send" },
          name: { type: "string" as const, description: "Filename (e.g. report.pdf)" },
          mimeType: { type: "string" as const, description: "MIME type (e.g. application/pdf). Auto-detected from extension if omitted." },
          text: { type: "string" as const, description: "Optional text message to include alongside the file" },
          agentId: { type: "string" as const, description: "Route to a specific agentId on the peer (OpenClaw extension). Omit to use the peer's default agent." },
        },
      };

      api.registerTool({
        name: "a2a_send_file",
        description: "Send a file to a peer agent via A2A. The file is referenced by its public URL (URI). " +
          "Use this when you need to transfer a document, image, or any file to another agent.",
        label: "A2A Send File",
        parameters: sendFileParams,
        async execute(toolCallId, params) {
          const peer = config.peers.find((p) => p.name === params.peer);
          if (!peer) {
            const available = config.peers.map((p) => p.name).join(", ") || "(none)";
            return {
              content: [{ type: "text" as const, text: `Peer not found: "${params.peer}". Available peers: ${available}` }],
              details: { ok: false },
            };
          }

          // Security checks: SSRF, MIME, file size
          const uriCheck = await validateUri(params.uri, config.security);
          if (!uriCheck.ok) {
            return {
              content: [{ type: "text" as const, text: `URI rejected: ${uriCheck.reason}` }],
              details: { ok: false, reason: uriCheck.reason },
            };
          }

          if (params.mimeType && !validateMimeType(params.mimeType, config.security.allowedMimeTypes)) {
            return {
              content: [{ type: "text" as const, text: `MIME type rejected: "${params.mimeType}" is not in the allowed list` }],
              details: { ok: false },
            };
          }

          const parts: Array<Record<string, unknown>> = [];
          if (params.text) {
            parts.push({ kind: "text", text: params.text });
          }
          parts.push({
            kind: "file",
            file: {
              uri: params.uri,
              ...(params.name ? { name: params.name } : {}),
              ...(params.mimeType ? { mimeType: params.mimeType } : {}),
            },
          });

          try {
            const message: Record<string, unknown> = { parts };
            if (params.agentId) {
              message.agentId = params.agentId;
            }
            const result = await client.sendMessage(peer, message, {
              healthManager: healthManager ?? undefined,
              retryConfig: config.resilience.retry,
            });
            if (result.ok) {
              return {
                content: [{ type: "text" as const, text: `File sent to ${params.peer} via A2A.\nURI: ${params.uri}\nResponse: ${JSON.stringify(result.response)}` }],
                details: { ok: true, response: result.response },
              };
            }
            return {
              content: [{ type: "text" as const, text: `Failed to send file to ${params.peer}: ${JSON.stringify(result.response)}` }],
              details: { ok: false, response: result.response },
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: `Error sending file to ${params.peer}: ${msg}` }],
              details: { ok: false, error: msg },
            };
          }
        },
      });

      // ------------------------------------------------------------------
      // Agent tool: a2a_match_request
      // Creates a match request on the hub and submits this agent's token.
      // Returns provider address + yourToken + peerToken for A2A communication.
      // ------------------------------------------------------------------
      api.registerTool({
        name: "a2a_match_request",
        description: "Request a match with another agent via the hub. " +
          "The hub finds a provider agent with matching skills, creates a match record, " +
          "and returns the provider's address along with tokens for secure A2A communication. " +
          "Use this to discover and connect with peer agents through the hub's registry.",
        label: "A2A Match Request",
        parameters: {
          type: "object" as const,
          required: ["skills"],
          properties: {
            skills: {
              type: "array" as const,
              items: { type: "string" as const },
              description: "List of skill names to search for in a provider agent",
            },
            description: {
              type: "string" as const,
              description: "Optional description of what you need from the provider",
            },
          },
        },
        async execute(toolCallId, params) {
          let client: HubMatchClient;
          try {
            client = await HubMatchClient.create();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: `Not registered with hub: ${msg}` }],
              details: { ok: false, error: msg },
            };
          }

          let match: Awaited<ReturnType<HubMatchClient["createMatch"]>>;
          try {
            match = await client.createMatch({
              skills: params.skills,
              description: params.description,
              token: getAdvertisedInboundToken(config, client) ?? client.registrationToken,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: `Failed to create match: ${msg}` }],
              details: { ok: false, error: msg },
            };
          }

          // Submit our token
          let updatedMatch: Awaited<ReturnType<HubMatchClient["submitToken"]>>;
          try {
            updatedMatch = await client.submitToken(
              match.id,
              getAdvertisedInboundToken(config, client) ?? client.registrationToken,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: `Match created (id=${match.id}) but failed to submit token: ${msg}` }],
              details: { ok: false, matchId: match.id, error: msg },
            };
          }

          const provider = updatedMatch.provider;
          const providerAddress = provider?.address ?? "(unknown)";
          const providerAccessToken = updatedMatch.yourToken ?? "(none)";
          const requesterInboundToken = updatedMatch.peerToken ?? "(none)";
          const status = updatedMatch.status;

          return {
            content: [{
              type: "text" as const,
              text: `Match ${status}: id=${updatedMatch.id}\n` +
                `Provider: ${provider?.name ?? "(unknown)"} at ${providerAddress}\n` +
                `Provider access token (use to contact provider): ${providerAccessToken}\n` +
                `Requester inbound token (provider uses this to contact you): ${requesterInboundToken}`,
            }],
            details: {
              ok: true,
              matchId: updatedMatch.id,
              status: updatedMatch.status,
              providerAddress,
              yourToken: providerAccessToken,
              peerToken: requesterInboundToken,
            },
          };
        },
      });
    }

    if (!api.registerService) {
      api.logger.warn("claw-crony: registerService is unavailable; HTTP endpoints are not started");
      return;
    }

    api.registerService({
      id: "claw-crony",
      async start(_ctx) {
        if (server) {
          return;
        }

        // Hub registration (runs before server starts)
        if (config.hub?.enabled !== false && config.hub?.registrationEnabled !== false) {
          try {
            const reg = await runHubRegistration(api, config, config.hub!, config.registration ?? {});
            if (reg) {
              api.logger.info(`claw-crony: registered with hub (agentId=${reg.agentId})`);
            }
          } catch (err) {
            api.logger.warn(`claw-crony: hub registration failed — ${err instanceof Error ? err.message : String(err)}`);
            // Continue startup anyway — hub is optional
          }
        }

        // Start peer health checks
        healthManager?.start();

        // Start HTTP server (JSON-RPC + REST)
        await new Promise<void>((resolve, reject) => {
          server = app.listen(config.server.port, config.server.host, () => {
            api.logger.info(
              `claw-crony: HTTP listening on ${config.server.host}:${config.server.port}`
            );
            api.logger.info(
              `claw-crony: durable task store at ${config.storage.tasksDir}; concurrency=${config.limits.maxConcurrentTasks}; queue=${config.limits.maxQueuedTasks}`
            );
            resolve();
          });

          server!.once("error", reject);
        });

        // Start gRPC server
        try {
          grpcServer = new GrpcServer();
          const grpcUserBuilder = async (
            call: { metadata?: { get: (key: string) => unknown[] } } | unknown,
          ) => {
            if (config.security.inboundAuth === "bearer" && config.security.validTokens.size > 0) {
              const meta = (call as any)?.metadata;
              const values = meta?.get?.("authorization") || meta?.get?.("Authorization") || [];
              const header = Array.isArray(values) && values.length > 0 ? String(values[0]) : "";
              const providedToken = header.startsWith("Bearer ") ? header.slice(7) : "";
              if (!providedToken || !config.security.validTokens.has(providedToken)) {
                telemetry.recordSecurityRejection("grpc", "invalid or missing bearer token");
                auditLogger.recordSecurityEvent("grpc", "invalid or missing bearer token");
                const err: any = new Error("Unauthorized: invalid or missing bearer token");
                err.code = GrpcStatus.UNAUTHENTICATED;
                throw err;
              }
            }
            return GrpcUserBuilder.noAuthentication();
          };

          grpcServer.addService(
            A2AService,
            grpcService({ requestHandler, userBuilder: grpcUserBuilder as any })
          );

          await new Promise<void>((resolve, reject) => {
            grpcServer!.bindAsync(
              `${config.server.host}:${grpcPort}`,
              ServerCredentials.createInsecure(),
              (error) => {
                if (error) {
                  api.logger.warn(`claw-crony: gRPC failed to start: ${error.message}`);
                  grpcServer = null;
                  resolve(); // Non-fatal: HTTP still works
                  return;
                }
                try {
                  grpcServer!.start();
                } catch {
                  // ignore: some grpc-js versions auto-start
                }
                api.logger.info(
                  `claw-crony: gRPC listening on ${config.server.host}:${grpcPort}`
                );
                resolve();
              }
            );
          });
        } catch (grpcError: unknown) {
          const msg = grpcError instanceof Error ? grpcError.message : String(grpcError);
          api.logger.warn(`claw-crony: gRPC init failed: ${msg}`);
          grpcServer = null;
        }

        // Start task TTL cleanup
        const ttlMs = config.storage.taskTtlHours * 3_600_000;
        const intervalMs = config.storage.cleanupIntervalMinutes * 60_000;

        const doCleanup = () => {
          void runTaskCleanup(taskStore, ttlMs, telemetry, api.logger);
        };

        // Run once at startup to clear any backlog
        doCleanup();
        cleanupTimer = setInterval(doCleanup, intervalMs);

        if (config.hub?.enabled !== false) {
          const pollingIntervalMs = Math.max(5_000, config.resilience.healthCheck.intervalMs);
          const pollHubMatches = () => {
            void processPendingHubMatches(api, config, processedHubMatches);
          };

          pollHubMatches();
          hubMatchPollingTimer = setInterval(pollHubMatches, pollingIntervalMs);
          api.logger.info(`claw-crony: hub match polling enabled interval=${pollingIntervalMs}ms`);
        }

        api.logger.info(
          `claw-crony: task cleanup enabled — ttl=${config.storage.taskTtlHours}h interval=${config.storage.cleanupIntervalMinutes}min`,
        );
      },
      async stop(_ctx) {
        // Stop peer health checks
        healthManager?.stop();
        auditLogger.close();

        // Stop task cleanup timer
        if (cleanupTimer) {
          clearInterval(cleanupTimer);
          cleanupTimer = null;
        }

        if (hubMatchPollingTimer) {
          clearInterval(hubMatchPollingTimer);
          hubMatchPollingTimer = null;
        }

        // Stop gRPC server
        if (grpcServer) {
          grpcServer.forceShutdown();
          grpcServer = null;
        }

        // Stop HTTP server
        if (!server) {
          return;
        }

        await new Promise<void>((resolve, reject) => {
          const activeServer = server!;
          server = null;
          activeServer.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      },
    });
  },
};

export default plugin;

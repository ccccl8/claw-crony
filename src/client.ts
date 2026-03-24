import { v4 as uuidv4 } from "uuid";
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  createAuthenticatingFetchWithRetry,
  type AuthenticationHandler,
  type HttpHeaders,
} from "@a2a-js/sdk/client";
import { GrpcTransportFactory } from "@a2a-js/sdk/client/grpc";
import type { MessageSendParams, Message } from "@a2a-js/sdk";

import type { OutboundSendResult, PeerConfig, RetryConfig } from "./types.js";
import type { PeerHealthManager } from "./peer-health.js";
import { withRetry } from "./peer-retry.js";
import {
  orderTransports,
  isRetryableTransportError,
  type TransportEndpoint,
} from "./transport-fallback.js";

/**
 * Build an AuthenticationHandler for bearer or apiKey auth.
 */
function createAuthHandler(peer: PeerConfig): AuthenticationHandler | undefined {
  const auth = peer.auth;
  if (!auth?.token) return undefined;

  const headerKey = auth.type === "bearer" ? "authorization" : "x-api-key";
  const headerValue = auth.type === "bearer" ? `Bearer ${auth.token}` : auth.token;

  return {
    headers: async (): Promise<HttpHeaders> => ({
      [headerKey]: headerValue,
    }),
    shouldRetryWithHeaders: async () => undefined,
  };
}

/**
 * Parse agentCardUrl into base URL and path.
 */
function parseAgentCardUrl(agentCardUrl: string): { baseUrl: string; path: string } {
  const parsed = new URL(agentCardUrl);
  return {
    baseUrl: parsed.origin,
    path: parsed.pathname,
  };
}

export class A2AClient {
  /**
   * Create a ClientFactory with auth-aware fetch for a given peer.
   */
  private buildFactory(peer: PeerConfig): { factory: ClientFactory; path: string } {
    const { baseUrl: _baseUrl, path } = parseAgentCardUrl(peer.agentCardUrl);
    const authHandler = createAuthHandler(peer);

    // Wrap global fetch with auth headers if configured
    const authFetch = authHandler
      ? createAuthenticatingFetchWithRetry(fetch, authHandler)
      : fetch;

    // Inject auth fetch into card resolver and all transports
    const options = ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      cardResolver: new DefaultAgentCardResolver({ fetchImpl: authFetch }),
      transports: [
        new JsonRpcTransportFactory({ fetchImpl: authFetch }),
        new RestTransportFactory({ fetchImpl: authFetch }),
        new GrpcTransportFactory(),
      ],
    });

    return { factory: new ClientFactory(options), path };
  }

  /**
   * Discover a peer's Agent Card using the SDK resolver.
   * Used for both card discovery and health probes.
   *
   * @param timeoutMs  Override timeout (default 30s; health checks use 5s).
   */
  async discoverAgentCard(peer: PeerConfig, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const { baseUrl, path } = parseAgentCardUrl(peer.agentCardUrl);
    const { factory } = this.buildFactory(peer);

    // createFromUrl resolves the card internally
    await factory.createFromUrl(baseUrl, path);

    // Re-fetch the card for the return value (lightweight)
    const authHandler = createAuthHandler(peer);
    const headers: Record<string, string> = authHandler
      ? (await authHandler.headers()) as Record<string, string>
      : {};

    const response = await fetch(`${baseUrl}${path}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Agent Card lookup failed with status ${response.status}`);
    }

    return response.json();
  }

  /**
   * Send a message to a peer agent using the A2A SDK Client.
   *
   * Implements transport fallback: when the preferred transport fails with a
   * retryable transport error (connection refused, timeout, 5xx), the next
   * available transport (REST → gRPC) is tried automatically.
   *
   * Circuit-breaker and retry-with-backoff are applied on top of the
   * transport fallback loop.
   */
  async sendMessage(
    peer: PeerConfig,
    message: Record<string, unknown>,
    options?: {
      healthManager?: PeerHealthManager;
      retryConfig?: RetryConfig;
      log?: (level: "info" | "warn", msg: string, details?: Record<string, unknown>) => void;
    },
  ): Promise<OutboundSendResult> {
    const healthManager = options?.healthManager;
    const retryConfig = options?.retryConfig;

    // Circuit breaker: reject immediately if peer is unavailable
    if (healthManager && !healthManager.isAvailable(peer.name)) {
      return {
        ok: false,
        statusCode: 503,
        response: { error: `Circuit open: peer "${peer.name}" is unavailable` },
      };
    }

    const doSend = () => this.doSendMessage(peer, message, options?.log);

    let result: OutboundSendResult;
    if (retryConfig && retryConfig.maxRetries > 0) {
      result = await withRetry(doSend, retryConfig, options?.log, peer.name);
    } else {
      result = await doSend();
    }

    // Update health manager
    if (healthManager) {
      if (result.ok) {
        healthManager.recordSuccess(peer.name);
      } else {
        healthManager.recordFailure(peer.name);
      }
    }

    return result;
  }

  /**
   * Core send logic with automatic transport fallback.
   *
   * 1. Build the outbound A2A message (shared across all transports).
   * 2. Resolve the Agent Card to discover available transports from
   *    `additionalInterfaces` and order them by priority (JSON-RPC > REST > gRPC).
   * 3. Try transports in priority order; on retryable transport errors
   *    (connection refused, timeout, 5xx) fall back to the next transport.
   *    Auth errors (401/403) and A2A protocol errors are NOT retried on
   *    a different transport — they would fail identically.
   * 4. When there is only one transport or card resolution fails,
   *    fall back to the original single-transport SDK path.
   */
  private async doSendMessage(
    peer: PeerConfig,
    message: Record<string, unknown>,
    log?: (level: "info" | "warn", msg: string, details?: Record<string, unknown>) => void,
  ): Promise<OutboundSendResult> {
    const { baseUrl, path } = parseAgentCardUrl(peer.agentCardUrl);

    // ------------------------------------------------------------------
    // 1. Build the outbound A2A message
    // ------------------------------------------------------------------
    const targetAgentId = typeof (message as any)?.agentId === "string" ? String((message as any).agentId) : "";

    const outboundMessage: any = {
      kind: "message",
      messageId: (message.messageId as string) || uuidv4(),
      role: (message.role as Message["role"]) || "user",
      parts: (message.parts as Message["parts"]) || [
        { kind: "text", text: String(message.text || message.message || "") },
      ],
    };

    if (targetAgentId) {
      outboundMessage.agentId = targetAgentId;
    }

    const sendParams: MessageSendParams = { message: outboundMessage };

    const serviceParameters: Record<string, string> = {};
    if (peer.auth?.token) {
      if (peer.auth.type === "bearer") {
        serviceParameters.authorization = `Bearer ${peer.auth.token}`;
      } else {
        serviceParameters["x-api-key"] = peer.auth.token;
      }
    }

    const requestOptions = {
      serviceParameters: Object.keys(serviceParameters).length ? serviceParameters : undefined,
    };

    // ------------------------------------------------------------------
    // 2. Resolve Agent Card for transport list
    // ------------------------------------------------------------------
    let transports: TransportEndpoint[] = [];

    try {
      const resolver = new DefaultAgentCardResolver({
        fetchImpl: peer.auth?.token
          ? createAuthenticatingFetchWithRetry(fetch, createAuthHandler(peer)!)
          : fetch,
      });
      const agentCard = await resolver.resolve(baseUrl, path) as Record<string, unknown>;

      const mainTransport = (agentCard.preferredTransport as string) ?? "JSONRPC";
      const cardUrl = (agentCard.url as string) ?? `${baseUrl}${path}`;

      const allInterfaces: TransportEndpoint[] = [{ url: cardUrl, transport: mainTransport }];

      const additionalInterfaces = agentCard.additionalInterfaces as Array<{ url: string; transport: string }> | undefined;
      if (additionalInterfaces) {
        for (const iface of additionalInterfaces) {
          if (iface.url !== cardUrl || iface.transport !== mainTransport) {
            allInterfaces.push({ url: iface.url, transport: iface.transport });
          }
        }
      }

      transports = orderTransports(allInterfaces);
    } catch {
      // Card resolution failed — let the SDK pick the default transport
      transports = [];
    }

    // ------------------------------------------------------------------
    // 3. Single-transport fallback path (original)
    // ------------------------------------------------------------------
    if (transports.length <= 1) {
      return this.doSendViaFactory(peer, sendParams, requestOptions);
    }

    // ------------------------------------------------------------------
    // 4. Transport fallback loop
    // ------------------------------------------------------------------
    let lastError: unknown;

    for (let i = 0; i < transports.length; i++) {
      const endpoint = transports[i];

      log?.("info", "transport.try", {
        peer: peer.name,
        transport: endpoint.transport,
        url: endpoint.url,
        attempt: i + 1,
        total: transports.length,
      });

      try {
        const result = await this.doSendViaTransport(endpoint, sendParams, requestOptions);

        if (result.ok || !isRetryableTransportError(result)) {
          if (i > 0) {
            log?.("info", "transport.fallback.success", {
              peer: peer.name,
              transport: endpoint.transport,
              url: endpoint.url,
              attemptIndex: i,
            });
          }
          return result;
        }

        // Retryable transport error → try next transport
        lastError = result;
        log?.("warn", "transport.fallback", {
          peer: peer.name,
          failedTransport: endpoint.transport,
          statusCode: result.statusCode,
          error: (result.response as any)?.error,
        });
      } catch (error: unknown) {
        if (!isRetryableTransportError(error)) {
          // Non-retryable error (auth, protocol) → stop immediately
          return {
            ok: false,
            statusCode: 500,
            response: { error: error instanceof Error ? error.message : String(error) },
          };
        }

        // Retryable error → try next transport
        lastError = error;
        log?.("warn", "transport.fallback", {
          peer: peer.name,
          failedTransport: endpoint.transport,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // All transports exhausted
    const errorMessage = lastError instanceof Error
      ? lastError.message
      : typeof lastError === "object" && lastError !== null && "response" in lastError
        ? ((lastError as any).response as any)?.error ?? String(lastError)
        : String(lastError);

    return {
      ok: false,
      statusCode: 500,
      response: { error: `All transports failed for peer "${peer.name}": ${errorMessage}` },
    };
  }

  /**
   * Send via the SDK's ClientFactory (single-transport path).
   */
  private async doSendViaFactory(
    peer: PeerConfig,
    sendParams: MessageSendParams,
    requestOptions: { serviceParameters?: Record<string, string> },
  ): Promise<OutboundSendResult> {
    const { factory, path } = this.buildFactory(peer);

    try {
      const client = await factory.createFromUrl(peer.agentCardUrl, path);
      const result = await client.sendMessage(sendParams, requestOptions);
      return {
        ok: true,
        statusCode: 200,
        response: result as unknown as Record<string, unknown>,
      };
    } catch (error: unknown) {
      // Re-throw so withRetry can classify the error
      throw error;
    }
  }

  /**
   * Send via a specific transport endpoint (no auth — uses bearer token in serviceParameters).
   */
  private async doSendViaTransport(
    endpoint: TransportEndpoint,
    sendParams: MessageSendParams,
    requestOptions: { serviceParameters?: Record<string, string> },
  ): Promise<OutboundSendResult> {
    let transport;

    switch (endpoint.transport) {
      case "JSONRPC": {
        const factory = new JsonRpcTransportFactory();
        transport = await factory.create(endpoint.url, {} as any);
        break;
      }
      case "HTTP+JSON": {
        const factory = new RestTransportFactory();
        transport = await factory.create(endpoint.url, {} as any);
        break;
      }
      case "GRPC": {
        const factory = new GrpcTransportFactory();
        transport = await factory.create(endpoint.url, {} as any);
        break;
      }
      default:
        return {
          ok: false,
          statusCode: 500,
          response: { error: `Unsupported transport: ${endpoint.transport}` },
        };
    }

    try {
      const result = await transport.sendMessage(sendParams, requestOptions);
      return {
        ok: true,
        statusCode: 200,
        response: result as unknown as Record<string, unknown>,
      };
    } catch (error: unknown) {
      // Re-throw so the fallback loop can classify the error
      throw error;
    }
  }
}

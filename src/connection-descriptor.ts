import type { ConnectionDescriptor, ConnectionEndpoint } from "./types.js";

const A2A_TRANSPORT_PRIORITY = ["jsonrpc", "http-json", "grpc"];

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function priority(endpoint: ConnectionEndpoint): number {
  const index = A2A_TRANSPORT_PRIORITY.indexOf(normalize(endpoint.transport));
  return index === -1 ? A2A_TRANSPORT_PRIORITY.length : index;
}

function metadataAgentCardUrl(endpoint: ConnectionEndpoint): string | null {
  const value = endpoint.metadata?.agentCardUrl;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function deriveAgentCardUrlFromEndpoint(endpointUrl: string): string | null {
  try {
    const parsed = new URL(endpointUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return `${parsed.origin}/.well-known/agent.json`;
  } catch {
    return null;
  }
}

export function buildAgentCardUrlFromAddress(address: string, agentCardPath = "/.well-known/agent.json"): string {
  const normalizedAddress = address.startsWith("http://") || address.startsWith("https://")
    ? address
    : `http://${address}`;
  const normalizedPath = agentCardPath.startsWith("/") ? agentCardPath : `/${agentCardPath}`;
  return `${normalizedAddress.replace(/\/$/, "")}${normalizedPath}`;
}

export function resolveA2aAgentCardUrl(descriptor?: ConnectionDescriptor | null): string | null {
  const endpoints = descriptor?.endpoints
    ?.filter((endpoint) => normalize(endpoint.protocol) === "a2a")
    .sort((a, b) => priority(a) - priority(b)) ?? [];

  for (const endpoint of endpoints) {
    const agentCardUrl = metadataAgentCardUrl(endpoint);
    if (agentCardUrl) {
      return agentCardUrl;
    }
  }

  for (const endpoint of endpoints) {
    const agentCardUrl = deriveAgentCardUrlFromEndpoint(endpoint.url);
    if (agentCardUrl) {
      return agentCardUrl;
    }
  }

  return null;
}

export function resolvePeerAgentCardUrl(
  descriptor: ConnectionDescriptor | undefined | null,
  fallbackAddress: string,
  fallbackAgentCardPath = "/.well-known/agent.json",
): string {
  return resolveA2aAgentCardUrl(descriptor) ?? buildAgentCardUrlFromAddress(fallbackAddress, fallbackAgentCardPath);
}

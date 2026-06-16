import { resolveA2aAgentCardUrl } from "../connection-descriptor.js";
import type { ConnectionDescriptor, ConnectionEndpoint } from "../types.js";

export interface A2aAdapterPlan {
  available: boolean;
  agentCardUrl?: string;
  endpoint?: ConnectionEndpoint;
  reason?: string;
}

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function selectA2aEndpoint(descriptor?: ConnectionDescriptor | null): ConnectionEndpoint | undefined {
  return descriptor?.endpoints?.find((endpoint) => normalize(endpoint.protocol) === "a2a");
}

export function planA2aAdapter(descriptor?: ConnectionDescriptor | null): A2aAdapterPlan {
  if (!descriptor) {
    return {
      available: false,
      reason: "peer did not publish a connection descriptor",
    };
  }

  const endpoint = selectA2aEndpoint(descriptor);
  const agentCardUrl = resolveA2aAgentCardUrl(descriptor) ?? undefined;
  if (!endpoint && !agentCardUrl) {
    return {
      available: false,
      reason: "peer did not publish an A2A endpoint",
    };
  }

  if (!agentCardUrl) {
    return {
      available: false,
      endpoint,
      reason: "peer published A2A metadata but no agent card URL could be resolved",
    };
  }

  return {
    available: true,
    agentCardUrl,
    endpoint,
  };
}

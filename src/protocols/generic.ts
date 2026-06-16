import type { ConnectionDescriptor, ConnectionEndpoint } from "../types.js";

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function collectProtocols(descriptor?: ConnectionDescriptor | null): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const values = [
    ...(descriptor?.capabilities?.protocols ?? []),
    ...(descriptor?.endpoints ?? []).map((endpoint) => endpoint.protocol),
  ];

  for (const value of values) {
    const normalized = normalize(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function describeEndpoint(endpoint: ConnectionEndpoint): string {
  const parts = [
    `${endpoint.protocol}/${endpoint.transport}: ${endpoint.url}`,
    endpoint.auth ? `auth=${endpoint.auth}` : undefined,
  ].filter(Boolean);
  return parts.join(" ");
}

export function describeDescriptor(label: string, descriptor?: ConnectionDescriptor | null): string[] {
  if (!descriptor) {
    return [`${label}: no connection descriptor`];
  }

  const protocols = collectProtocols(descriptor);
  const endpoints = descriptor.endpoints?.map((endpoint) => `  - ${describeEndpoint(endpoint)}`) ?? [];
  return [
    `${label}: clientId=${descriptor.clientId}`,
    `  protocols=[${protocols.length ? protocols.join(", ") : "(none)"}]`,
    ...(endpoints.length ? endpoints : ["  endpoints=(none)"]),
  ];
}

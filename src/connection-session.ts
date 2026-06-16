import { planA2aAdapter, type A2aAdapterPlan } from "./protocols/a2a.js";
import { collectProtocols, describeDescriptor } from "./protocols/generic.js";
import type { ConnectionDescriptor } from "./types.js";

export interface ConnectionSessionLike {
  id: number;
  requestId: number;
  offerId: number;
  requesterAgentId?: number | null;
  responderAgentId: number;
  requesterClientId?: string | null;
  requesterPublicKey?: string | null;
  requesterSigningPublicKey?: string | null;
  requesterConnectionDescriptor?: ConnectionDescriptor | null;
  responderClientId?: string | null;
  responderPublicKey?: string | null;
  responderSigningPublicKey?: string | null;
  responderConnectionDescriptor?: ConnectionDescriptor | null;
  status: string;
  sharedContextRoomId?: string | null;
}

export interface ConnectionParticipantView {
  role: "requester" | "responder";
  agentId?: number | null;
  clientId?: string | null;
  encryptionPublicKey?: string | null;
  signingPublicKey?: string | null;
  descriptor?: ConnectionDescriptor | null;
  protocols: string[];
}

export interface ConnectionSessionView {
  sessionId: number;
  requestId: number;
  offerId: number;
  status: string;
  requester: ConnectionParticipantView;
  responder: ConnectionParticipantView;
  recommendedMode: "a2a" | "generic";
  a2a: A2aAdapterPlan;
  generic: {
    protocols: string[];
    endpointCount: number;
  };
  nextSteps: string[];
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function buildParticipant(
  role: "requester" | "responder",
  input: {
    agentId?: number | null;
    clientId?: string | null;
    encryptionPublicKey?: string | null;
    signingPublicKey?: string | null;
    descriptor?: ConnectionDescriptor | null;
  },
): ConnectionParticipantView {
  return {
    role,
    ...input,
    protocols: collectProtocols(input.descriptor),
  };
}

export function buildConnectionSessionView(session: ConnectionSessionLike): ConnectionSessionView {
  const requester = buildParticipant("requester", {
    agentId: session.requesterAgentId,
    clientId: session.requesterClientId,
    encryptionPublicKey: session.requesterPublicKey,
    signingPublicKey: session.requesterSigningPublicKey,
    descriptor: session.requesterConnectionDescriptor,
  });
  const responder = buildParticipant("responder", {
    agentId: session.responderAgentId,
    clientId: session.responderClientId,
    encryptionPublicKey: session.responderPublicKey,
    signingPublicKey: session.responderSigningPublicKey,
    descriptor: session.responderConnectionDescriptor,
  });
  const a2a = planA2aAdapter(responder.descriptor);
  const protocols = dedupe([...requester.protocols, ...responder.protocols]);
  const endpointCount = (requester.descriptor?.endpoints?.length ?? 0) + (responder.descriptor?.endpoints?.length ?? 0);
  const recommendedMode = a2a.available ? "a2a" : "generic";

  return {
    sessionId: session.id,
    requestId: session.requestId,
    offerId: session.offerId,
    status: session.status,
    requester,
    responder,
    recommendedMode,
    a2a,
    generic: {
      protocols,
      endpointCount,
    },
    nextSteps: buildNextSteps(recommendedMode, a2a, protocols, endpointCount),
  };
}

function buildNextSteps(
  recommendedMode: "a2a" | "generic",
  a2a: A2aAdapterPlan,
  protocols: string[],
  endpointCount: number,
): string[] {
  if (recommendedMode === "a2a") {
    return [
      `A2A is available via ${a2a.agentCardUrl}. Use it only if both sides want the built-in A2A workflow.`,
      "For non-A2A collaboration, use the published descriptors and public keys directly.",
    ];
  }

  return [
    `A2A is not selected: ${a2a.reason ?? "no A2A endpoint was resolved"}.`,
    endpointCount > 0
      ? `Use one of the generic protocols/endpoints instead: ${protocols.join(", ") || "(none declared)"}.`
      : "No generic endpoint was published; the Hub session still exchanged client ids and public keys for an out-of-band connection.",
  ];
}

export function formatConnectionSession(session: ConnectionSessionLike): string {
  const view = buildConnectionSessionView(session);
  return [
    `Connection session #${session.id} is ${session.status}.`,
    `requestId=${session.requestId} offerId=${session.offerId}`,
    `recommendedMode=${view.recommendedMode}`,
    "",
    "Requester identity:",
    `  agentId=${session.requesterAgentId ?? "(unknown)"}`,
    `  clientId=${session.requesterClientId ?? "(unknown)"}`,
    `  x25519=${session.requesterPublicKey ?? "(none)"}`,
    `  ed25519=${session.requesterSigningPublicKey ?? "(none)"}`,
    "",
    "Responder identity:",
    `  agentId=${session.responderAgentId}`,
    `  clientId=${session.responderClientId ?? "(unknown)"}`,
    `  x25519=${session.responderPublicKey ?? "(none)"}`,
    `  ed25519=${session.responderSigningPublicKey ?? "(none)"}`,
    "",
    ...describeDescriptor("Requester descriptor", session.requesterConnectionDescriptor),
    "",
    ...describeDescriptor("Responder descriptor", session.responderConnectionDescriptor),
    "",
    view.a2a.available
      ? `A2A adapter: available (${view.a2a.agentCardUrl})`
      : `A2A adapter: unavailable (${view.a2a.reason ?? "not resolved"})`,
    "Next steps:",
    ...view.nextSteps.map((step) => `- ${step}`),
  ].join("\n");
}

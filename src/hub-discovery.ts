import type { RequestHistoryStore } from "./history.js";
import { HubMatchClient } from "./hub-match.js";
import {
  buildAgentResolution,
  buildGenericMatchResolution,
  formatResolvedHubAgent,
  type GenericMatchResolution,
} from "./hub-resolve.js";

export interface HubDiscoveryMatchInput {
  skills: string[];
  description?: string;
  preferOfficial?: boolean;
  targetAgentId?: number;
  targetClientId?: string;
}

export interface HubDiscoveryResolveInput {
  agentId?: number;
  clientId?: string;
  matchId?: number;
  skills?: string[];
  description?: string;
  preferOfficial?: boolean;
  targetAgentId?: number;
  targetClientId?: string;
}

export interface HubDiscoveryFailure {
  ok: false;
  error: string;
  matchId?: number;
}

export interface HubDiscoveryResult {
  ok: boolean;
  text: string;
  details: GenericMatchResolution | HubDiscoveryFailure;
}

async function createHubMatchClient(
  historyStore: RequestHistoryStore,
  startedAt: number,
  type: "match.failed" | "resolve.failed",
): Promise<HubMatchClient | string> {
  try {
    return await HubMatchClient.create();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    historyStore.record({
      type,
      status: "failure",
      direction: "outbound",
      durationMs: Date.now() - startedAt,
      detail: { reason: msg },
    });
    return msg;
  }
}

export async function performGenericHubMatch(
  input: HubDiscoveryMatchInput,
  historyStore: RequestHistoryStore,
): Promise<HubDiscoveryResult> {
  const startedAt = Date.now();
  const hubClientOrError = await createHubMatchClient(historyStore, startedAt, "match.failed");
  if (typeof hubClientOrError === "string") {
    return {
      ok: false,
      text: `Not registered with hub: ${hubClientOrError}`,
      details: { ok: false, error: hubClientOrError },
    };
  }
  const hubClient = hubClientOrError;

  let match: Awaited<ReturnType<HubMatchClient["createMatch"]>>;
  try {
    match = await hubClient.createMatch({
      skills: input.skills,
      description: input.description,
      connectionMode: "generic",
      preferOfficial: input.preferOfficial,
      targetAgentId: input.targetAgentId,
      targetClientId: input.targetClientId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    historyStore.record({
      type: "match.failed",
      status: "failure",
      direction: "outbound",
      durationMs: Date.now() - startedAt,
      detail: { reason: msg, skills: input.skills, mode: "generic" },
    });
    return {
      ok: false,
      text: `Failed to create generic Hub match: ${msg}`,
      details: { ok: false, error: msg },
    };
  }

  const resolved = buildGenericMatchResolution(match, hubClient.agentId, "generic_match");
  historyStore.record({
    type: "match.resolved",
    status: "success",
    direction: "outbound",
    matchId: match.id,
    peer: resolved.peer?.name,
    durationMs: Date.now() - startedAt,
    detail: {
      mode: "generic",
      skills: input.skills,
      description: input.description,
      providerAgentId: match.provider?.id,
      protocols: resolved.peer?.connectionProtocols,
    },
  });

  return {
    ok: true,
    text: `Generic Hub match resolved: match=${match.id}\n${formatResolvedHubAgent(resolved.peer)}`,
    details: resolved,
  };
}

export async function resolveHubPeer(
  input: HubDiscoveryResolveInput,
  historyStore: RequestHistoryStore,
): Promise<HubDiscoveryResult> {
  if (input.skills && input.skills.length > 0) {
    return performGenericHubMatch({
      skills: input.skills,
      description: input.description,
      preferOfficial: input.preferOfficial,
      targetAgentId: input.targetAgentId,
      targetClientId: input.targetClientId,
    }, historyStore);
  }

  const startedAt = Date.now();
  const hubClientOrError = await createHubMatchClient(historyStore, startedAt, "resolve.failed");
  if (typeof hubClientOrError === "string") {
    return {
      ok: false,
      text: `Not registered with hub: ${hubClientOrError}`,
      details: { ok: false, error: hubClientOrError },
    };
  }
  const hubClient = hubClientOrError;

  try {
    let resolved: GenericMatchResolution;
    if (input.matchId != null) {
      const match = await hubClient.getMatch(input.matchId, hubClient.agentId);
      resolved = buildGenericMatchResolution(match, hubClient.agentId, "resolve");
    } else if (input.agentId != null) {
      const agent = await hubClient.getAgent(input.agentId);
      resolved = buildAgentResolution(agent, hubClient.agentId);
    } else if (input.clientId) {
      const agent = await hubClient.findAgentByClientId(input.clientId);
      if (!agent) {
        return {
          ok: false,
          text: `No Hub agent found for clientId=${input.clientId}`,
          details: { ok: false, error: "agent_not_found" },
        };
      }
      resolved = buildAgentResolution(agent, hubClient.agentId);
    } else {
      return {
        ok: false,
        text: "Provide matchId, agentId, clientId, or skills.",
        details: { ok: false, error: "resolve_target_required" },
      };
    }

    historyStore.record({
      type: "resolve.completed",
      status: "success",
      direction: "outbound",
      matchId: resolved.matchId,
      peer: resolved.peer?.name,
      durationMs: Date.now() - startedAt,
      detail: {
        agentId: input.agentId,
        clientId: input.clientId,
        matchId: input.matchId,
        protocols: resolved.peer?.connectionProtocols,
      },
    });
    return {
      ok: true,
      text: `Hub agent resolved:\n${formatResolvedHubAgent(resolved.peer)}`,
      details: resolved,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    historyStore.record({
      type: "resolve.failed",
      status: "failure",
      direction: "outbound",
      matchId: input.matchId,
      durationMs: Date.now() - startedAt,
      detail: {
        reason: msg,
        agentId: input.agentId,
        clientId: input.clientId,
      },
    });
    return {
      ok: false,
      text: `Failed to resolve Hub agent: ${msg}`,
      details: { ok: false, error: msg, matchId: input.matchId },
    };
  }
}

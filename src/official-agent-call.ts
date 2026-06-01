import { validateUriSchemeAndIp, sanitizeUriForLog } from "./file-security.js";
import type { RequestHistoryStore } from "./history.js";
import { HubMatchClient, type HubAgentDto } from "./hub-match.js";
import { buildAgentResolution, buildGenericMatchResolution, summarizeHubAgent, type ResolvedHubAgent } from "./hub-resolve.js";
import type { ConnectionEndpoint } from "./types.js";

export interface OfficialAgentCallInput {
  agentId?: number;
  clientId?: string;
  skills?: string[];
  description?: string;
  actionName: string;
  body?: unknown;
  query?: Record<string, unknown>;
  preferOfficial?: boolean;
}

export interface OfficialAgentCallResult {
  ok: boolean;
  text: string;
  details: Record<string, unknown>;
}

export interface SensitiveFinding {
  type: string;
  message: string;
  path?: string;
}

export interface PreparedOfficialAgentCall {
  agent: ResolvedHubAgent;
  actionName: string;
  method: "GET" | "POST";
  url: string;
  bodyText?: string;
  headers: Record<string, string>;
}

interface NormalizedAction {
  name: string;
  riskLevel: string;
  method: "GET" | "POST";
  path: string;
}

const MAX_INPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_CHARS = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const SENSITIVE_KEY_RE = /(token|authorization|cookie|session|secret|password|api[_-]?key)/i;
const PHONE_RE = /(?:^|[^\d])1[3-9]\d{9}(?!\d)/;
const PAYMENT_RE = /(pay\.weixin|alipay|payment|支付|付款|收款|二维码|qr[_-]?code)/i;
const ORDER_ID_KEY_RE = /(order[_-]?id|订单号|运单号)/i;
const ADDRESS_RE = /([\u4e00-\u9fa5A-Za-z0-9#\-]{10,}(省|市|区|县|镇|乡|村|路|街|巷|号|栋|幢|单元|室|小区|大厦|广场)[\u4e00-\u9fa5A-Za-z0-9#\-]*)/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function lower(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function uniqueFindings(findings: SensitiveFinding[]): SensitiveFinding[] {
  const seen = new Set<string>();
  const result: SensitiveFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.type}:${finding.path ?? ""}:${finding.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(finding);
  }
  return result;
}

function normalizeIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
}

function forbiddenList(agent: HubAgentDto | ResolvedHubAgent, policyKey: "inputPolicy" | "outputPolicy"): string[] {
  const policy = asRecord(agent.capabilityManifest?.[policyKey]);
  const forbidden = policy?.forbidden;
  if (!Array.isArray(forbidden)) {
    return [];
  }
  return forbidden.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function scanText(text: string, path: string, forbidden: Set<string>, findings: SensitiveFinding[]): void {
  if ((forbidden.size === 0 || forbidden.has("full_phone_number") || forbidden.has("rider_phone")) && PHONE_RE.test(text)) {
    findings.push({ type: "full_phone_number", message: "Text appears to contain a full phone number.", path });
  }
  if ((forbidden.size === 0 || forbidden.has("payment_link") || forbidden.has("payment_qr_code")) && PAYMENT_RE.test(text)) {
    findings.push({ type: "payment_info", message: "Text appears to contain payment or QR-code information.", path });
  }
  if ((forbidden.has("order_id") || forbidden.has("waybill_id")) && ORDER_ID_KEY_RE.test(text)) {
    findings.push({ type: "order_id", message: "Text appears to contain an order or waybill identifier.", path });
  }
  if ((forbidden.size === 0 || forbidden.has("full_address")) && ADDRESS_RE.test(text)) {
    findings.push({ type: "full_address", message: "Text appears to contain a detailed address.", path });
  }
}

function scanValue(value: unknown, path: string, forbidden: Set<string>, findings: SensitiveFinding[]): void {
  if (typeof value === "string") {
    scanText(value, path, forbidden, findings);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanValue(entry, `${path}[${index}]`, forbidden, findings));
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }

  for (const [key, entry] of Object.entries(record)) {
    const keyPath = path ? `${path}.${key}` : key;
    const normalizedKey = normalizeIdentifier(key);
    for (const forbiddenEntry of forbidden) {
      const normalizedForbidden = normalizeIdentifier(forbiddenEntry);
      if (normalizedForbidden && normalizedKey.includes(normalizedForbidden)) {
        findings.push({
          type: forbiddenEntry,
          message: "Input or output key matches an official agent forbidden field.",
          path: keyPath,
        });
      }
    }
    if ((forbidden.size === 0 || forbidden.has("tencent_token") || forbidden.has("token")) && SENSITIVE_KEY_RE.test(key)) {
      findings.push({ type: "secret_key", message: "Input key appears to contain a token, cookie, session, or secret.", path: keyPath });
    }
    if ((forbidden.has("order_id") || forbidden.has("waybill_id")) && ORDER_ID_KEY_RE.test(key)) {
      findings.push({ type: "order_id", message: "Input key appears to contain an order or waybill identifier.", path: keyPath });
    }
    if (forbidden.has("internal_api_payload") && /internal|apiPayload|api_payload/i.test(key)) {
      findings.push({ type: "internal_api_payload", message: "Input key appears to contain internal API payload data.", path: keyPath });
    }
    scanValue(entry, keyPath, forbidden, findings);
  }
}

export function detectSensitiveOfficialAgentInput(value: unknown, forbiddenEntries: string[] = []): SensitiveFinding[] {
  const forbidden = new Set(forbiddenEntries.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  const findings: SensitiveFinding[] = [];
  scanValue(value, "", forbidden, findings);
  return uniqueFindings(findings);
}

function normalizeAction(raw: unknown): NormalizedAction | null {
  const action = asRecord(raw);
  if (!action) {
    return null;
  }

  const name = asString(action.name);
  const riskLevel = lower(action.riskLevel);
  let method = lower(action.method).toUpperCase();
  let path = asString(action.path);
  const endpoint = asString(action.endpoint);

  if ((!method || !path) && endpoint) {
    const match = endpoint.match(/^([A-Za-z]+)\s+(\S+)$/);
    if (match) {
      method = match[1].toUpperCase();
      path = match[2];
    }
  }

  if (!name || !riskLevel || !path || (method !== "GET" && method !== "POST")) {
    return null;
  }

  return {
    name,
    riskLevel,
    method,
    path,
  };
}

function findAction(agent: HubAgentDto, actionName: string): NormalizedAction | null {
  const actions = agent.capabilityManifest?.actions;
  if (!Array.isArray(actions)) {
    return null;
  }
  const normalizedName = actionName.trim().toLowerCase();
  for (const raw of actions) {
    const action = normalizeAction(raw);
    if (action && action.name.toLowerCase() === normalizedName) {
      return action;
    }
  }
  return null;
}

function endpointPriority(endpoint: ConnectionEndpoint): number {
  const protocol = endpoint.protocol.trim().toLowerCase();
  if (protocol === "custom-http") return 0;
  if (protocol === "http" || protocol === "https") return 1;
  if (protocol === "http-json" || endpoint.transport.toLowerCase().includes("http")) return 2;
  return 10;
}

function selectHttpEndpoint(agent: HubAgentDto): ConnectionEndpoint | null {
  return [...(agent.connectionDescriptor?.endpoints ?? [])]
    .filter((endpoint) => endpoint.protocol.trim().toLowerCase() !== "openapi")
    .filter((endpoint) => {
      const protocol = endpoint.protocol.trim().toLowerCase();
      const transport = endpoint.transport.trim().toLowerCase();
      return protocol.includes("http") || transport.includes("http") || transport === "https";
    })
    .sort((a, b) => endpointPriority(a) - endpointPriority(b))[0] ?? null;
}

function buildActionUrl(baseUrl: string, actionPath: string, query?: Record<string, unknown>): string {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(actionPath)) {
    throw new Error("official action endpoint must be a path, not an absolute URL");
  }

  const base = new URL(baseUrl);
  if (base.protocol !== "https:") {
    throw new Error("official agent endpoint must use HTTPS");
  }
  if (base.username || base.password) {
    throw new Error("official agent endpoint must not include URL credentials");
  }
  const schemeOrIpError = validateUriSchemeAndIp(base.href);
  if (schemeOrIpError) {
    throw new Error(`official agent endpoint is blocked: ${schemeOrIpError}`);
  }

  const basePath = base.pathname.replace(/\/+$/, "");
  const relativePath = actionPath.replace(/^\/+/, "");
  const url = new URL(base.href);
  url.pathname = [basePath, relativePath].filter(Boolean).join("/");
  url.search = "";

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value == null) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry != null) url.searchParams.append(key, String(entry));
        }
      } else if (typeof value === "object") {
        url.searchParams.set(key, JSON.stringify(value));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return url.toString();
}

function serializeBody(method: "GET" | "POST", body: unknown): string | undefined {
  if (method === "GET") {
    return undefined;
  }
  return JSON.stringify(body ?? {});
}

export function prepareOfficialAgentActionCall(
  agent: HubAgentDto,
  input: Pick<OfficialAgentCallInput, "actionName" | "body" | "query">,
): { ok: true; request: PreparedOfficialAgentCall } | { ok: false; error: string; message: string; findings?: SensitiveFinding[] } {
  if (!agent.official || !agent.verified) {
    return {
      ok: false,
      error: "agent_not_official_verified",
      message: "Only Hub official and verified agents can be called through this tool.",
    };
  }

  const actionName = input.actionName.trim();
  if (!actionName) {
    return { ok: false, error: "action_name_required", message: "actionName is required." };
  }

  const action = findAction(agent, actionName);
  if (!action) {
    return {
      ok: false,
      error: "action_not_declared",
      message: `Official agent does not declare action "${actionName}".`,
    };
  }
  if (action.riskLevel !== "low") {
    return {
      ok: false,
      error: "action_not_low_risk",
      message: `Official agent action "${actionName}" is not declared as low risk.`,
    };
  }

  const endpoint = selectHttpEndpoint(agent);
  if (!endpoint) {
    return {
      ok: false,
      error: "official_http_endpoint_missing",
      message: "Official agent does not publish a supported HTTPS endpoint.",
    };
  }
  if (endpoint.auth && endpoint.auth.trim().toLowerCase() !== "none") {
    return {
      ok: false,
      error: "official_endpoint_auth_unsupported",
      message: "Official agent endpoint requires public auth metadata that this tool does not support.",
    };
  }

  const findings = detectSensitiveOfficialAgentInput(
    { body: input.body, query: input.query },
    forbiddenList(agent, "inputPolicy"),
  );
  if (findings.length > 0) {
    return {
      ok: false,
      error: "sensitive_input_blocked",
      message: "Input appears to contain sensitive data. Redact it locally before calling the official agent.",
      findings,
    };
  }

  const bodyText = serializeBody(action.method, input.body);
  const inputBytes = byteLength(JSON.stringify({ body: input.body ?? null, query: input.query ?? null }));
  if (inputBytes > MAX_INPUT_BYTES) {
    return {
      ok: false,
      error: "input_too_large",
      message: `Official agent input exceeds ${MAX_INPUT_BYTES} bytes.`,
    };
  }

  let url: string;
  try {
    url = buildActionUrl(endpoint.url, action.path, action.method === "GET" ? input.query : undefined);
  } catch (err) {
    return {
      ok: false,
      error: "official_endpoint_invalid",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const resolved = summarizeHubAgent(agent);
  if (!resolved) {
    return { ok: false, error: "agent_resolution_failed", message: "Official agent could not be resolved." };
  }

  return {
    ok: true,
    request: {
      agent: resolved,
      actionName: action.name,
      method: action.method,
      url,
      bodyText,
      headers: action.method === "POST" ? { "Content-Type": "application/json" } : {},
    },
  };
}

function truncateOutput(value: string): string {
  return value.length <= MAX_OUTPUT_CHARS ? value : `${value.slice(0, MAX_OUTPUT_CHARS)}...[truncated]`;
}

async function readResponse(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = truncateOutput(await res.text());
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

async function resolveOfficialAgent(input: OfficialAgentCallInput, hubClient: HubMatchClient): Promise<{ agent: HubAgentDto; matchId?: number }> {
  if (input.agentId != null) {
    return { agent: await hubClient.getAgent(input.agentId) };
  }
  if (input.clientId) {
    const agent = await hubClient.findAgentByClientId(input.clientId);
    if (!agent) {
      throw new Error(`No Hub agent found for clientId=${input.clientId}`);
    }
    return { agent };
  }
  if (input.skills && input.skills.length > 0) {
    const match = await hubClient.createMatch({
      skills: input.skills,
      description: input.description,
      connectionMode: "generic",
      preferOfficial: input.preferOfficial ?? true,
    });
    const resolved = buildGenericMatchResolution(match, hubClient.agentId, "generic_match");
    const peerAgentId = resolved.peer?.agentId;
    if (!peerAgentId) {
      throw new Error("Hub match did not resolve a peer official agent.");
    }
    return { agent: await hubClient.getAgent(peerAgentId), matchId: match.id };
  }
  throw new Error("Provide agentId, clientId, or skills to call an official agent.");
}

export async function callOfficialAgentAction(
  input: OfficialAgentCallInput,
  historyStore: RequestHistoryStore,
  fetchImpl: typeof fetch = fetch,
): Promise<OfficialAgentCallResult> {
  const startedAt = Date.now();
  let matchId: number | undefined;
  let agentName: string | undefined;

  try {
    const hubClient = await HubMatchClient.create();
    const resolved = await resolveOfficialAgent(input, hubClient);
    matchId = resolved.matchId;
    agentName = resolved.agent.name;

    const prepared = prepareOfficialAgentActionCall(resolved.agent, input);
    if (!prepared.ok) {
      historyStore.record({
        type: "official_agent.call_failed",
        status: "failure",
        direction: "outbound",
        matchId,
        peer: agentName,
        durationMs: Date.now() - startedAt,
        detail: {
          reason: prepared.error,
          actionName: input.actionName,
          findings: prepared.findings,
        },
      });
      return {
        ok: false,
        text: prepared.message,
        details: {
          ok: false,
          error: prepared.error,
          message: prepared.message,
          findings: prepared.findings,
        },
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(prepared.request.url, {
        method: prepared.request.method,
        headers: prepared.request.headers,
        body: prepared.request.bodyText,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const responseBody = await readResponse(response);
    if (!response.ok) {
      throw new Error(`Official agent returned HTTP ${response.status}: ${JSON.stringify(responseBody)}`);
    }

    const outputFindings = detectSensitiveOfficialAgentInput(responseBody, forbiddenList(resolved.agent, "outputPolicy"));
    if (outputFindings.length > 0) {
      historyStore.record({
        type: "official_agent.call_failed",
        status: "failure",
        direction: "outbound",
        matchId,
        peer: agentName,
        durationMs: Date.now() - startedAt,
        detail: {
          reason: "sensitive_output_blocked",
          actionName: input.actionName,
          url: sanitizeUriForLog(prepared.request.url),
          findings: outputFindings,
        },
      });
      return {
        ok: false,
        text: "Official agent response appears to contain sensitive data, so it was not returned.",
        details: {
          ok: false,
          error: "sensitive_output_blocked",
          findings: outputFindings,
          agent: prepared.request.agent,
          actionName: prepared.request.actionName,
        },
      };
    }

    const resolution = buildAgentResolution(resolved.agent, hubClient.agentId);
    historyStore.record({
      type: "official_agent.call_completed",
      status: "success",
      direction: "outbound",
      matchId,
      peer: agentName,
      durationMs: Date.now() - startedAt,
      detail: {
        actionName: prepared.request.actionName,
        method: prepared.request.method,
        url: sanitizeUriForLog(prepared.request.url),
        statusCode: response.status,
      },
    });

    return {
      ok: true,
      text: `Official agent call completed: ${agentName} / ${prepared.request.actionName}`,
      details: {
        ok: true,
        agent: resolution.peer,
        matchId,
        actionName: prepared.request.actionName,
        method: prepared.request.method,
        url: prepared.request.url,
        statusCode: response.status,
        response: responseBody,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    historyStore.record({
      type: "official_agent.call_failed",
      status: "failure",
      direction: "outbound",
      matchId,
      peer: agentName,
      durationMs: Date.now() - startedAt,
      detail: {
        reason: msg,
        actionName: input.actionName,
      },
    });
    return {
      ok: false,
      text: `Failed to call official agent: ${msg}`,
      details: {
        ok: false,
        error: msg,
        matchId,
      },
    };
  }
}

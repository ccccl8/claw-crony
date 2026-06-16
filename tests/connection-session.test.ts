import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildConnectionSessionView, formatConnectionSession } from "../src/connection-session.js";
import type { ConnectionDescriptor } from "../src/types.js";

function descriptor(protocol: string, url: string): ConnectionDescriptor {
  return {
    version: "openclaw-connect/1",
    clientId: "peer-client",
    publicKeys: {},
    endpoints: [{
      protocol,
      transport: protocol === "a2a" ? "jsonrpc" : "http-json",
      url,
      metadata: protocol === "a2a" ? { agentCardUrl: "https://peer.example/.well-known/agent.json" } : undefined,
    }],
    capabilities: {
      skills: ["chat"],
      protocols: [protocol],
    },
  };
}

describe("connection session output", () => {
  it("keeps A2A as an optional adapter when an A2A endpoint is published", () => {
    const session = {
      id: 10,
      requestId: 20,
      offerId: 30,
      requesterAgentId: 1,
      responderAgentId: 2,
      requesterClientId: "requester-client",
      responderClientId: "responder-client",
      requesterConnectionDescriptor: descriptor("http", "https://requester.example/connect"),
      responderConnectionDescriptor: descriptor("a2a", "https://peer.example/a2a/jsonrpc"),
      status: "ready",
    };

    const view = buildConnectionSessionView(session);

    assert.equal(view.recommendedMode, "a2a");
    assert.equal(view.a2a.available, true);
    assert.equal(view.a2a.agentCardUrl, "https://peer.example/.well-known/agent.json");
    assert.match(formatConnectionSession(session), /A2A adapter: available/);
  });

  it("falls back to generic connection materials when no A2A endpoint is published", () => {
    const session = {
      id: 11,
      requestId: 21,
      offerId: 31,
      responderAgentId: 3,
      requesterConnectionDescriptor: descriptor("mcp", "https://requester.example/mcp"),
      responderConnectionDescriptor: descriptor("websocket", "wss://peer.example/ws"),
      status: "ready",
    };

    const view = buildConnectionSessionView(session);
    const text = formatConnectionSession(session);

    assert.equal(view.recommendedMode, "generic");
    assert.equal(view.a2a.available, false);
    assert.deepEqual(view.generic.protocols, ["mcp", "websocket"]);
    assert.match(text, /A2A adapter: unavailable/);
    assert.match(text, /Use one of the generic protocols/);
  });
});

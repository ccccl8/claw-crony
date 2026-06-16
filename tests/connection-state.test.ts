import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildConnectionSessionView } from "../src/connection-session.js";
import { ConnectionStateStore, formatConnectionState } from "../src/connection-state.js";
import type { HubConnectionRequest, HubConnectionSession } from "../src/hub-connection-requests.js";
import type { ConnectionDescriptor } from "../src/types.js";

function tmpStatePath(): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "claw-crony-state-"));
  return { dir, file: path.join(dir, "state.json") };
}

function descriptor(protocol: string): ConnectionDescriptor {
  return {
    version: "openclaw-connect/1",
    clientId: "peer-client",
    publicKeys: {},
    endpoints: [{
      protocol,
      transport: "http-json",
      url: `https://peer.example/${protocol}`,
    }],
    capabilities: {
      skills: ["chat"],
      protocols: [protocol],
    },
  };
}

describe("ConnectionStateStore", () => {
  it("records created requests with newest record first and deduped ids", () => {
    const { dir, file } = tmpStatePath();
    try {
      const store = new ConnectionStateStore(file);
      const request: HubConnectionRequest = {
        id: 1,
        title: "Need a tool agent",
        summary: "Need help with an MCP endpoint",
        requestType: "task",
        requiredSkills: ["tool_use"],
        collaborationMode: "any",
        status: "open",
        moderationStatus: "approved",
      };

      store.recordRequest(request);
      store.recordRequest({ ...request, title: "Need a different tool agent" });
      const state = store.snapshot();

      assert.deepEqual(state.createdRequestIds, [1]);
      assert.equal(state.requests.length, 1);
      assert.equal(state.requests[0].title, "Need a different tool agent");
      assert.match(formatConnectionState(state), /request #1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records sessions with protocol-neutral connection view summaries", () => {
    const { dir, file } = tmpStatePath();
    try {
      const store = new ConnectionStateStore(file);
      const session: HubConnectionSession = {
        id: 9,
        requestId: 2,
        offerId: 3,
        requesterAgentId: 4,
        responderAgentId: 5,
        requesterClientId: "requester-client",
        responderClientId: "responder-client",
        requesterConnectionDescriptor: descriptor("mcp"),
        responderConnectionDescriptor: descriptor("websocket"),
        status: "ready",
      };
      const view = buildConnectionSessionView(session);

      store.recordSession(session, view);
      const state = store.snapshot();

      assert.deepEqual(state.acceptedSessionIds, [9]);
      assert.equal(state.sessions[0].recommendedMode, "generic");
      assert.deepEqual(state.sessions[0].protocols, ["mcp", "websocket"]);
      assert.equal(state.sessions[0].responderClientId, "responder-client");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

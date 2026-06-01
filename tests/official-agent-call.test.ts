import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  detectSensitiveOfficialAgentInput,
  prepareOfficialAgentActionCall,
} from "../src/official-agent-call.js";
import type { HubAgentDto } from "../src/hub-match.js";

function officialAgent(overrides: Partial<HubAgentDto> = {}): HubAgentDto {
  return {
    id: 101,
    name: "Tencent Delivery Advisor",
    skills: ["tencent_delivery", "delivery_guidance"],
    official: true,
    verified: true,
    capabilityManifest: {
      actions: [
        { name: "next_step_advice", riskLevel: "low", endpoint: "POST /delivery-advisor/next" },
        { name: "policy", riskLevel: "low", endpoint: "GET /delivery-advisor/policy" },
      ],
      inputPolicy: {
        forbidden: [
          "tencent_token",
          "full_phone_number",
          "full_address",
          "payment_qr_code",
          "payment_link",
          "order_id",
        ],
      },
    },
    connectionDescriptor: {
      version: "openclaw-connect/1",
      clientId: "official.tencent-delivery-advisor",
      publicKeys: {},
      endpoints: [
        {
          protocol: "custom-http",
          transport: "https",
          url: "https://www.clawcrony.com/official-agents/tencent-delivery-advisor",
          auth: "none",
        },
        {
          protocol: "openapi",
          transport: "https",
          url: "https://www.clawcrony.com/official-agents/tencent-delivery-advisor/openapi.json",
          auth: "none",
        },
      ],
      capabilities: {
        skills: ["tencent_delivery", "delivery_guidance"],
        protocols: ["custom-http", "openapi"],
      },
    },
    ...overrides,
  };
}

describe("official agent calls", () => {
  it("prepares a low-risk official action call using the custom HTTPS base endpoint", () => {
    const prepared = prepareOfficialAgentActionCall(officialAgent(), {
      actionName: "next_step_advice",
      body: {
        userText: "Need to ship a document",
        localState: {
          stage: "ready",
          knownFields: { hasSender: false, hasReceiver: false, hasItem: true },
        },
      },
    });

    if (!prepared.ok) {
      assert.fail(prepared.message);
    }

    assert.equal(prepared.request.method, "POST");
    assert.equal(
      prepared.request.url,
      "https://www.clawcrony.com/official-agents/tencent-delivery-advisor/delivery-advisor/next",
    );
    assert.equal(prepared.request.headers["Content-Type"], "application/json");
    assert.match(prepared.request.bodyText ?? "", /Need to ship a document/);
  });

  it("blocks agents that are not both official and verified", () => {
    const prepared = prepareOfficialAgentActionCall(officialAgent({ verified: false }), {
      actionName: "next_step_advice",
      body: { userText: "Need guidance" },
    });

    assert.equal(prepared.ok, false);
    if (!prepared.ok) {
      assert.equal(prepared.error, "agent_not_official_verified");
    }
  });

  it("blocks undeclared high-risk actions", () => {
    const prepared = prepareOfficialAgentActionCall(officialAgent({
      capabilityManifest: {
        actions: [
          { name: "book_order", riskLevel: "high", endpoint: "POST /delivery-advisor/book" },
        ],
      },
    }), {
      actionName: "book_order",
      body: { userText: "book it" },
    });

    assert.equal(prepared.ok, false);
    if (!prepared.ok) {
      assert.equal(prepared.error, "action_not_low_risk");
    }
  });

  it("blocks sensitive input before preparing the HTTP call", () => {
    const prepared = prepareOfficialAgentActionCall(officialAgent(), {
      actionName: "next_step_advice",
      body: { userText: "Please call 13812345678 for me" },
    });

    assert.equal(prepared.ok, false);
    if (!prepared.ok) {
      assert.equal(prepared.error, "sensitive_input_blocked");
      assert.equal(prepared.findings?.[0]?.type, "full_phone_number");
    }
  });

  it("detects sensitive keys recursively", () => {
    const findings = detectSensitiveOfficialAgentInput({
      localState: {
        auth: {
          tencentToken: "secret",
        },
      },
    }, ["tencent_token"]);

    assert.equal(findings[0]?.type, "tencent_token");
    assert.equal(findings[0]?.path, "localState.auth.tencentToken");
  });
});

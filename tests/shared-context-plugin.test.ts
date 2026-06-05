import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  createHarness,
  invokeGatewayMethod,
  makeConfig,
  registerPlugin,
} from "./helpers.js";

let tmpDir: string;
let storePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-context-plugin-test-"));
  storePath = path.join(tmpDir, "shared-context.jsonl");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSharedConfig(overrides: Record<string, unknown> = {}) {
  const sharedOverrides = (overrides.sharedContext && typeof overrides.sharedContext === "object")
    ? overrides.sharedContext as Record<string, unknown>
    : {};
  const mergedOverrides = { ...overrides };
  delete mergedOverrides.sharedContext;

  return makeConfig({
    hub: { enabled: false, registrationEnabled: false },
    profile: { plazaEnabled: false, autoSyncOnStartup: false },
    sharedContext: {
      enabled: true,
      storePath,
      maxMessageChars: 10_000,
      maxMessagesPerRead: 25,
      httpEnabled: true,
      httpPath: "/openclaw/shared-context/jsonrpc",
      ...sharedOverrides,
    },
    ...mergedOverrides,
  });
}

function randomPort() {
  return 20000 + Math.floor(Math.random() * 20000);
}

async function rpcCall(port: number, method: string, params: Record<string, unknown>, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/shared/jsonrpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method,
      params,
    }),
  });
  const body = await response.json() as Record<string, any>;
  return { response, body };
}

describe("shared context plugin surface", () => {
  it("creates, posts, reads, summarizes, and attaches artifacts through gateway methods", async () => {
    const harness = createHarness(makeSharedConfig());

    const created = await invokeGatewayMethod(harness, "openclaw.room.create", {
      title: "Agent sync",
      topic: "Shared progress",
      participants: ["codex"],
      tags: ["sync"],
      createdBy: "user",
    });
    assert.equal(created.ok, true);
    const room = (created.data as any).room as Record<string, unknown>;
    assert.equal(room.title, "Agent sync");

    const posted = await invokeGatewayMethod(harness, "openclaw.room.post", {
      roomId: room.id,
      author: "codex",
      kind: "decision",
      content: "Keep claw-crony as an information sharing layer.",
    });
    assert.equal(posted.ok, true);
    const message = (posted.data as any).message as Record<string, unknown>;
    assert.equal(message.kind, "decision");

    const artifact = await invokeGatewayMethod(harness, "openclaw.artifact.attach", {
      roomId: room.id,
      messageId: message.id,
      createdBy: "codex",
      kind: "note",
      name: "decision.md",
    });
    assert.equal(artifact.ok, true);

    const read = await invokeGatewayMethod(harness, "openclaw.room.read", {
      roomId: room.id,
      count: 5,
    });
    assert.equal(read.ok, true);
    const messages = (read.data as any).messages as Array<Record<string, unknown>>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, "Keep claw-crony as an information sharing layer.");

    const summary = await invokeGatewayMethod(harness, "openclaw.room.summary", {
      roomId: room.id,
    });
    assert.equal(summary.ok, true);
    assert.equal((summary.data as any).summary.messageCount, 1);
    assert.equal((summary.data as any).summary.artifactCount, 1);
    assert.equal((summary.data as any).summary.decisions[0].id, message.id);

    const archived = await invokeGatewayMethod(harness, "openclaw.room.archive", {
      roomId: room.id,
    });
    assert.equal(archived.ok, true);
    assert.equal((archived.data as any).room.status, "archived");

    const listed = await invokeGatewayMethod(harness, "openclaw.room.list", {
      status: "archived",
      count: 10,
    });
    assert.equal(listed.ok, true);
    assert.equal((listed.data as any).rooms[0].id, room.id);

    const rejectedPost = await invokeGatewayMethod(harness, "openclaw.room.post", {
      roomId: room.id,
      author: "codex",
      content: "late update",
    });
    assert.equal(rejectedPost.ok, false);
    assert.match((rejectedPost.data as any).error, /shared room is archived/);
  });

  it("exposes common shared room operations through agent tools", async () => {
    const { tools } = registerPlugin(makeSharedConfig());

    const createTool = tools.get("openclaw_room_create");
    const listTool = tools.get("openclaw_room_list");
    const postTool = tools.get("openclaw_room_post");
    const readTool = tools.get("openclaw_room_read");
    const summaryTool = tools.get("openclaw_room_summary");
    assert.ok(createTool, "openclaw_room_create should be registered");
    assert.ok(listTool, "openclaw_room_list should be registered");
    assert.ok(postTool, "openclaw_room_post should be registered");
    assert.ok(readTool, "openclaw_room_read should be registered");
    assert.ok(summaryTool, "openclaw_room_summary should be registered");

    const created = await createTool.execute("call-create", {
      title: "Tool sync",
      participants: ["codex", "opencode"],
      createdBy: "user",
    });
    assert.equal(created.details.ok, true);
    const roomId = created.details.room.id;

    const listed = await listTool.execute("call-list", {
      status: "open",
      count: 10,
    });
    assert.equal(listed.details.ok, true);
    assert.equal(listed.details.rooms[0].id, roomId);

    const posted = await postTool.execute("call-post", {
      roomId,
      author: "opencode",
      kind: "status_update",
      content: "Posted through a tool wrapper.",
    });
    assert.equal(posted.details.ok, true);

    const read = await readTool.execute("call-read", {
      roomId,
      count: 10,
    });
    assert.equal(read.details.ok, true);
    assert.equal(read.details.count, 1);
    assert.match(read.content[0].text, /Posted through a tool wrapper/);

    const summary = await summaryTool.execute("call-summary", { roomId });
    assert.equal(summary.details.ok, true);
    assert.equal(summary.details.summary.messageCount, 1);
    assert.deepEqual(summary.details.summary.participants, ["codex", "opencode"]);
  });

  it("exposes shared context operations through HTTP JSON-RPC", async () => {
    const port = randomPort();
    const { service } = registerPlugin(makeSharedConfig({
      server: { host: "127.0.0.1", port },
      sharedContext: { httpPath: "/shared/jsonrpc" },
    }));
    assert(service, "service should be registered");

    await service.start();
    try {
      const created = await rpcCall(port, "openclaw.room.create", {
        title: "HTTP room",
        participants: ["codex"],
        createdBy: "user",
      });
      assert.equal(created.response.status, 200);
      assert.equal(created.body.result.room.title, "HTTP room");
      const roomId = created.body.result.room.id;

      const posted = await rpcCall(port, "openclaw.room.post", {
        roomId,
        author: "codex",
        kind: "status_update",
        content: "Posted through HTTP JSON-RPC.",
      });
      assert.equal(posted.response.status, 200);
      assert.equal(posted.body.result.message.kind, "status_update");

      const read = await rpcCall(port, "openclaw.room.read", { roomId, count: 5 });
      assert.equal(read.response.status, 200);
      assert.equal(read.body.result.count, 1);
      assert.equal(read.body.result.messages[0].content, "Posted through HTTP JSON-RPC.");
    } finally {
      await service.stop();
    }
  });

  it("protects shared context HTTP JSON-RPC with inbound bearer auth when configured", async () => {
    const port = randomPort();
    const { service } = registerPlugin(makeSharedConfig({
      server: { host: "127.0.0.1", port },
      security: { inboundAuth: "bearer", token: "shared-secret" },
      sharedContext: { httpPath: "/shared/jsonrpc" },
    }));
    assert(service, "service should be registered");

    await service.start();
    try {
      const rejected = await rpcCall(port, "openclaw.room.list", {});
      assert.equal(rejected.response.status, 401);
      assert.equal(rejected.body.error.code, -32000);

      const accepted = await rpcCall(port, "openclaw.room.list", {}, {
        Authorization: "Bearer shared-secret",
      });
      assert.equal(accepted.response.status, 200);
      assert.equal(accepted.body.result.count, 0);
    } finally {
      await service.stop();
    }
  });
});

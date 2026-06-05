import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { SharedContextStore } from "../src/shared-context.js";

let tmpDir: string;
let storePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-context-test-"));
  storePath = path.join(tmpDir, "shared-context.jsonl");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("SharedContextStore", () => {
  it("creates rooms, posts messages, and reads them chronologically", async () => {
    const store = new SharedContextStore(storePath);
    const room = await store.createRoom({
      title: "Agent sync",
      topic: "Daily progress",
      participants: ["codex", "opencode", "codex"],
      tags: ["Code", "sync"],
      createdBy: "user",
    });

    const first = await store.postMessage({
      roomId: room.id,
      author: "codex",
      kind: "status_update",
      content: "Implemented shared room store.",
    });
    const second = await store.postMessage({
      roomId: room.id,
      author: "opencode",
      kind: "question",
      content: "Should artifacts be versioned?",
    });

    const messages = await store.readMessages(room.id, { count: 10 });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].id, first.id);
    assert.equal(messages[1].id, second.id);
    assert.equal(messages[0].kind, "status_update");
  });

  it("summarizes blockers, decisions, participants, and artifacts", async () => {
    const store = new SharedContextStore(storePath);
    const room = await store.createRoom({
      title: "Review room",
      participants: ["codex"],
      createdBy: "user",
    });
    await store.postMessage({
      roomId: room.id,
      author: "codex",
      kind: "decision",
      content: "Use protocol-neutral shared rooms.",
    });
    await store.postMessage({
      roomId: room.id,
      author: "claude",
      kind: "blocker",
      content: "Need user approval before broadcasting summaries.",
    });
    await store.attachArtifact({
      roomId: room.id,
      createdBy: "codex",
      kind: "diff",
      name: "shared-context.patch",
    });

    const summary = await store.summarizeRoom(room.id);
    assert.equal(summary.messageCount, 2);
    assert.equal(summary.artifactCount, 1);
    assert.deepEqual(summary.participants, ["claude", "codex"]);
    assert.equal(summary.decisions[0].content, "Use protocol-neutral shared rooms.");
    assert.equal(summary.blockers[0].content, "Need user approval before broadcasting summaries.");
  });

  it("preserves message content whitespace for code and diffs", async () => {
    const store = new SharedContextStore(storePath);
    const room = await store.createRoom({ title: "Code room", createdBy: "user" });
    const content = "  function run() {\n    return true;\n  }\n";

    const message = await store.postMessage({
      roomId: room.id,
      author: "codex",
      kind: "code",
      content,
    });

    assert.equal(message.content, content);
    const messages = await store.readMessages(room.id);
    assert.equal(messages[0].content, content);
  });

  it("persists events and can replay them from a new store instance", async () => {
    const store = new SharedContextStore(storePath);
    const room = await store.createRoom({ title: "Persistent room", createdBy: "user" });
    await store.postMessage({ roomId: room.id, author: "codex", content: "persisted" });

    const reopened = new SharedContextStore(storePath);
    const rooms = await reopened.listRooms();
    const messages = await reopened.readMessages(room.id);
    assert.equal(rooms.length, 1);
    assert.equal(rooms[0].title, "Persistent room");
    assert.equal(messages[0].content, "persisted");
  });

  it("serializes concurrent writes from the same store instance", async () => {
    const store = new SharedContextStore(storePath);
    const room = await store.createRoom({ title: "Concurrent room", createdBy: "user" });

    await Promise.all(Array.from({ length: 25 }, (_, index) => store.postMessage({
      roomId: room.id,
      author: `agent-${index}`,
      content: `update-${index}`,
      artifacts: [{ kind: "note", name: `artifact-${index}.md` }],
    })));

    const reopened = new SharedContextStore(storePath);
    const messages = await reopened.readMessages(room.id, { count: 50 });
    const summary = await reopened.summarizeRoom(room.id);
    assert.equal(messages.length, 25);
    assert.equal(summary.messageCount, 25);
    assert.equal(summary.artifactCount, 25);
  });

  it("archives rooms and supports status-filtered room listing", async () => {
    const store = new SharedContextStore(storePath);
    const openRoom = await store.createRoom({ title: "Open room", createdBy: "user" });
    const archivedRoom = await store.createRoom({ title: "Archived room", createdBy: "user" });

    const archived = await store.archiveRoom(archivedRoom.id);
    assert.equal(archived.status, "archived");

    const openRooms = await store.listRooms({ status: "open" });
    const archivedRooms = await store.listRooms({ status: "archived" });
    assert.deepEqual(openRooms.map((room) => room.id), [openRoom.id]);
    assert.deepEqual(archivedRooms.map((room) => room.id), [archivedRoom.id]);
  });

  it("rejects writes to archived rooms", async () => {
    const store = new SharedContextStore(storePath);
    const room = await store.createRoom({ title: "Closed room", createdBy: "user" });
    await store.archiveRoom(room.id);

    await assert.rejects(
      () => store.postMessage({ roomId: room.id, author: "codex", content: "late update" }),
      /shared room is archived/,
    );
    await assert.rejects(
      () => store.attachArtifact({ roomId: room.id, createdBy: "codex", kind: "note", name: "late.md" }),
      /shared room is archived/,
    );
  });

  it("enforces enabled and maxMessageChars limits", async () => {
    const disabled = new SharedContextStore(storePath, { enabled: false });
    await assert.rejects(
      () => disabled.createRoom({ title: "Disabled" }),
      /shared context is disabled/,
    );

    const store = new SharedContextStore(storePath, { maxMessageChars: 4 });
    const room = await store.createRoom({ title: "Limits" });
    await assert.rejects(
      () => store.postMessage({ roomId: room.id, author: "codex", content: "too long" }),
      /maxMessageChars/,
    );
  });
});

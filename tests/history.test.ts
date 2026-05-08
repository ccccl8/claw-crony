import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { RequestHistoryStore } from "../src/history.js";

let tmpDir: string;
let historyPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-test-"));
  historyPath = path.join(tmpDir, "history.jsonl");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("RequestHistoryStore", () => {
  it("writes JSONL entries and returns newest entries first", async () => {
    const store = new RequestHistoryStore(historyPath);
    store.record({ type: "match.created", status: "success", direction: "outbound", matchId: 1 });
    store.record({ type: "handshake.offer_sent", status: "success", direction: "outbound", matchId: 1 });
    store.close();

    const entries = await store.tail({ count: 2 });
    assert.equal(entries.length, 2);
    assert.equal(entries[0].type, "handshake.offer_sent");
    assert.equal(entries[1].type, "match.created");
  });

  it("redacts tokens, secrets, authorization headers, and ciphertext by default", async () => {
    const store = new RequestHistoryStore(historyPath);
    store.record({
      type: "handshake.answer_received",
      status: "success",
      direction: "inbound",
      matchId: 7,
      detail: {
        token: "abc123",
        nested: {
          authorization: "Bearer abc123",
          ciphertext: "encrypted-payload",
          safe: "visible",
        },
      },
    });

    const [entry] = await store.tail();
    assert.equal(entry.detail?.token, "[redacted]");
    assert.equal((entry.detail?.nested as any).authorization, "[redacted]");
    assert.equal((entry.detail?.nested as any).ciphertext, "[redacted]");
    assert.equal((entry.detail?.nested as any).safe, "visible");
  });

  it("can filter by matchId and peer", async () => {
    const store = new RequestHistoryStore(historyPath);
    store.record({ type: "match.created", status: "success", direction: "outbound", matchId: 1, peer: "alpha" });
    store.record({ type: "match.created", status: "success", direction: "outbound", matchId: 2, peer: "beta" });

    const entries = await store.tail({ matchId: 2, peer: "beta" });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].matchId, 2);
    assert.equal(entries[0].peer, "beta");
  });

  it("does not write when disabled", async () => {
    const store = new RequestHistoryStore(historyPath, { enabled: false });
    store.record({ type: "match.created", status: "success" });
    assert.equal(fs.existsSync(historyPath), false);
  });
});

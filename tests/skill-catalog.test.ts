import test from "node:test";
import assert from "node:assert/strict";

import { normalizeAgentCardSkills, normalizeConfiguredSkillName } from "../src/skill-catalog.js";

test("normalizeConfiguredSkillName normalizes casing and separators", () => {
  assert.equal(normalizeConfiguredSkillName(" Tool-Use "), "tool_use");
  assert.equal(normalizeConfiguredSkillName("image understanding"), "image_understanding");
});

test("normalizeAgentCardSkills keeps custom skills while deduplicating normalized names", () => {
  const normalized = normalizeAgentCardSkills([
    "Chat",
    "custom skill",
    { name: "custom-skill", description: "duplicate custom" },
    { id: "Vision", name: "Image Understanding", description: "Vision support" },
  ]);

  assert.deepEqual(normalized, [
    "chat",
    "custom_skill",
    { id: "vision", name: "image_understanding", description: "Vision support" },
  ]);
});

test("normalizeAgentCardSkills falls back to default chat skill when input is empty", () => {
  const normalized = normalizeAgentCardSkills([]);
  assert.deepEqual(normalized, [
    { id: "chat", name: "chat", description: "Chat bridge" },
  ]);
});

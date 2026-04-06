import type { AgentSkillConfig } from "./types.js";

export const PRESET_AGENT_SKILLS = [
  "chat",
  "search",
  "reasoning",
  "tool_use",
  "file_transfer",
  "image_understanding",
  "audio_understanding",
  "translation",
  "summarization",
  "ocr",
  "code_generation",
  "code_review",
  "data_analysis",
] as const;

export function normalizeConfiguredSkillName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_");
}

export function normalizeAgentCardSkills(
  rawSkills: Array<AgentSkillConfig | string> | undefined,
): Array<AgentSkillConfig | string> {
  if (!rawSkills || rawSkills.length === 0) {
    return [{ id: "chat", name: "chat", description: "Chat bridge" }];
  }

  const seen = new Set<string>();
  const normalized: Array<AgentSkillConfig | string> = [];

  for (const entry of rawSkills) {
    if (typeof entry === "string") {
      const normalizedName = normalizeConfiguredSkillName(entry);
      if (!normalizedName || seen.has(normalizedName)) {
        continue;
      }

      seen.add(normalizedName);
      normalized.push(normalizedName);
      continue;
    }

    const normalizedName = normalizeConfiguredSkillName(entry.name);
    if (!normalizedName || seen.has(normalizedName)) {
      continue;
    }

    seen.add(normalizedName);
    normalized.push({
      id: entry.id ? normalizeConfiguredSkillName(entry.id) : normalizedName,
      name: normalizedName,
      description: entry.description?.trim() || normalizedName,
    });
  }

  return normalized.length > 0
    ? normalized
    : [{ id: "chat", name: "chat", description: "Chat bridge" }];
}

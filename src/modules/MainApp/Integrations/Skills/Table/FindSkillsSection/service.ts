import { invoke } from "@tauri-apps/api/core";
import { appCacheDir, join } from "@tauri-apps/api/path";
import { mkdir, writeTextFile } from "@tauri-apps/plugin-fs";

import type { HubSkillDetail, HubSkillResult } from "@src/types/extensions";
import { openFileInWorkStation } from "@src/util/ui/openFileInWorkStation";

const MIN_SKILL_SEARCH_QUERY_LENGTH = 2;
const SKILL_SEARCH_LIMIT = 25;

export function normalizeSkillSearchQuery(query: string): string | null {
  const normalized = query.trim();
  return normalized.length >= MIN_SKILL_SEARCH_QUERY_LENGTH ? normalized : null;
}

export function sanitizeSkillFileSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "-") || "skill";
}

export async function searchSkillsHub(
  query: string
): Promise<HubSkillResult[]> {
  return invoke<HubSkillResult[]>("skills_hub_search", {
    query,
    limit: SKILL_SEARCH_LIMIT,
  });
}

export async function previewRemoteSkill(
  result: HubSkillResult
): Promise<void> {
  const detail = await invoke<HubSkillDetail>("skills_hub_detail", {
    slug: result.slug,
  });
  const skillMd = detail.skillMd?.trim();
  if (!skillMd) {
    throw new Error("No SKILL.md found in the skills.sh snapshot");
  }

  const baseDir = await appCacheDir();
  const skillDir = await join(
    baseDir,
    "skills-sh-preview",
    sanitizeSkillFileSegment(result.slug)
  );
  await mkdir(skillDir, { recursive: true });
  const filePath = await join(skillDir, "SKILL.md");
  await writeTextFile(filePath, skillMd);
  openFileInWorkStation(filePath, { defaultPreviewMode: true });
}

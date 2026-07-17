import type { TFunction } from "i18next";

import type { CursorRepo } from "@src/hooks/policies";
import { SKILL_SOURCE } from "@src/types/extensions";

interface SkillSourceInfo {
  path: string;
  source: string;
}

const REPO_SKILL_STORAGE_DIRS = [
  ".orgii/skills",
  ".cursor/skills",
  ".claude/skills",
  ".codex/skills",
  ".opencode/skills",
  ".gemini/antigravity-cli/skills",
  ".agents/skills",
  "skills",
] as const;

const USER_SKILL_STORAGE_DIRS = [
  ".orgii/skills",
  ".cursor/skills-cursor",
  ".claude/skills",
  ".claude/commands",
  ".codex/skills",
  ".opencode/skills",
  ".agents/skills",
  ".hermes/skills",
  ".openclaw/skills",
] as const;

export function normalizeSkillPath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/").replace(/\/+$/, "");
}

function pathContainsStorageDir(
  pathValue: string,
  storageDir: string
): boolean {
  return pathValue.includes(`/${storageDir}/`);
}

function resolveStorageDir(
  pathValue: string,
  candidates: readonly string[]
): string | null {
  return (
    candidates.find((storageDir) =>
      pathContainsStorageDir(pathValue, storageDir)
    ) ?? null
  );
}

function resolveDiscoveredStorageDir(pathValue: string): string | null {
  const segments = pathValue.split("/").filter(Boolean);
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];
    if (segment.startsWith(".") && nextSegment === "skills") {
      return `${segment}/skills`;
    }
    if (segment === "skills") {
      return "skills";
    }
  }
  return null;
}

function resolveSkillStorageDir(pathValue: string): string | null {
  return (
    resolveStorageDir(pathValue, REPO_SKILL_STORAGE_DIRS) ??
    resolveStorageDir(pathValue, USER_SKILL_STORAGE_DIRS) ??
    resolveDiscoveredStorageDir(pathValue)
  );
}

export function resolveSkillWorkspacePath(
  skill: SkillSourceInfo
): string | null {
  const skillPath = normalizeSkillPath(skill.path);
  const storageDir = resolveSkillStorageDir(skillPath);
  if (!storageDir) return null;
  const marker = `/${storageDir}/`;
  const markerIndex = skillPath.indexOf(marker);
  return markerIndex > 0 ? skillPath.slice(0, markerIndex) : null;
}

export function resolveSkillWorkspace(
  skill: SkillSourceInfo,
  cursorRepos?: CursorRepo[]
): CursorRepo | null {
  const workspacePath = resolveSkillWorkspacePath(skill);
  if (!workspacePath) return null;
  return (
    cursorRepos?.find(
      (repo) => normalizeSkillPath(repo.path) === workspacePath
    ) ?? null
  );
}

export function getSkillResolvedSourceLabel(
  t: TFunction,
  skill: SkillSourceInfo,
  cursorRepos?: CursorRepo[]
): string {
  if (skill.source === SKILL_SOURCE.EMBEDDED_BUILTIN) {
    return t("scopeLabels.builtIn");
  }
  const workspace = resolveSkillWorkspace(skill, cursorRepos);
  if (workspace) return workspace.name;

  const skillPath = normalizeSkillPath(skill.path);
  const storageDir = resolveSkillStorageDir(skillPath);
  if (storageDir) return storageDir;

  return t("scopeLabels.user");
}

export function getSkillStorageLocationLabel(
  t: TFunction,
  skill: SkillSourceInfo,
  cursorRepos?: CursorRepo[]
): string {
  if (skill.source === SKILL_SOURCE.EMBEDDED_BUILTIN) {
    return t("scopeLabels.builtIn");
  }

  const skillPath = normalizeSkillPath(skill.path);
  const workspace = resolveSkillWorkspace(skill, cursorRepos);
  if (workspace) {
    return resolveSkillStorageDir(skillPath) ?? t("scopeLabels.repoSpecific");
  }

  return resolveSkillStorageDir(skillPath) ?? t("scopeLabels.user");
}

export function isRepoSkill(
  skill: SkillSourceInfo,
  cursorRepos?: CursorRepo[]
): boolean {
  return resolveSkillWorkspace(skill, cursorRepos) != null;
}

export function isUserSkill(
  skill: SkillSourceInfo,
  cursorRepos?: CursorRepo[]
): boolean {
  return (
    skill.source !== SKILL_SOURCE.EMBEDDED_BUILTIN &&
    !isRepoSkill(skill, cursorRepos)
  );
}

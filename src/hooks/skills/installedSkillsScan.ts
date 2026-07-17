/**
 * Bounded, coalesced installed-skills scanner.
 *
 * `skills_list` is a filesystem scan on the Rust side. Several UI surfaces
 * (the "/" slash menu, the pinned-actions "…" panel, the Skills manager) used
 * to each fire it *eagerly on mount* and re-fire on scope churn — mounting a
 * chat input therefore hammered the backend with repeated scans. This module
 * funnels every scan through a single cache so that:
 *   - concurrent scans of the same scope share one in-flight request, and
 *   - repeat scans of a scope within {@link SKILLS_SCAN_TTL_MS} reuse the
 *     cached result — unless `force` is set (e.g. right after an install /
 *     toggle / delete, where the caller needs fresh data).
 *
 * Result: no surface can trigger unlimited scans, and callers stay lazy —
 * they scan only when the user actually opens the menu/panel or when a pinned
 * skill needs its path resolved.
 */
import { invoke } from "@tauri-apps/api/core";

import { createLogger } from "@src/hooks/logger";
import { mergeInstalledSkills } from "@src/hooks/skills/installedSkillsMerge";
import type { InstalledSkill } from "@src/types/extensions";

const logger = createLogger("installedSkillsScan");

/** Reuse a scope's cached scan for this long before hitting the backend again. */
export const SKILLS_SCAN_TTL_MS = 15_000;
/** Cap the number of distinct workspace scopes we keep cached (LRU). */
const MAX_SCOPE_CACHE_SIZE = 16;

interface ScopeEntry {
  items: InstalledSkill[];
  fetchedAt: number;
}

const cacheByScope = new Map<string, ScopeEntry>();
const inflightByScope = new Map<string, Promise<InstalledSkill[]>>();

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function toScope(scopePaths: readonly string[]): {
  key: string;
  paths: string[];
} {
  const seen = new Set<string>();
  for (const path of scopePaths) {
    const normalized = normalizeWorkspacePath(path);
    if (normalized) seen.add(normalized);
  }
  const paths = [...seen].sort();
  return { key: paths.join("\0"), paths };
}

function rememberScope(key: string, items: InstalledSkill[]): void {
  if (!cacheByScope.has(key)) {
    while (cacheByScope.size >= MAX_SCOPE_CACHE_SIZE) {
      const oldestKey = cacheByScope.keys().next().value;
      if (oldestKey === undefined) break;
      cacheByScope.delete(oldestKey);
    }
  }
  cacheByScope.set(key, { items, fetchedAt: Date.now() });
}

/** Synchronously read the last cached scan for a scope, or `null` if none. */
export function peekInstalledSkills(
  scopePaths: readonly string[]
): InstalledSkill[] | null {
  const { key } = toScope(scopePaths);
  return cacheByScope.get(key)?.items ?? null;
}

/**
 * Scan installed skills for the given workspace scope. Always queries the
 * global scope (`workspacePath: null`) plus each supplied path, then merges
 * and de-dupes. Bounded: coalesces concurrent callers and reuses a recent
 * result unless `force` is passed.
 */
export async function scanInstalledSkills(
  scopePaths: readonly string[] = [],
  options: { force?: boolean } = {}
): Promise<InstalledSkill[]> {
  const { force = false } = options;
  const { key, paths } = toScope(scopePaths);

  const inflight = inflightByScope.get(key);
  if (inflight) return inflight;

  if (!force) {
    const cached = cacheByScope.get(key);
    if (cached && Date.now() - cached.fetchedAt < SKILLS_SCAN_TTL_MS) {
      return cached.items;
    }
  }

  const run = (async () => {
    const tasks: Promise<InstalledSkill[]>[] = [
      invoke<InstalledSkill[]>("skills_list", { workspacePath: null }),
      ...paths.map((path) =>
        invoke<InstalledSkill[]>("skills_list", { workspacePath: path })
      ),
    ];
    const results = await Promise.allSettled(tasks);
    const lists: InstalledSkill[][] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        lists.push(result.value);
      } else {
        logger.warn("skills_list failed for a scope:", result.reason);
      }
    }
    const merged = mergeInstalledSkills(lists);
    rememberScope(key, merged);
    return merged;
  })().finally(() => {
    inflightByScope.delete(key);
  });

  inflightByScope.set(key, run);
  return run;
}

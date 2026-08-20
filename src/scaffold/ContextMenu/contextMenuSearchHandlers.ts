/**
 * contextMenuSearchHandlers
 *
 * Pure async search functions for each context-menu layer type.
 * Extracted from useContextMenu to keep the hook file under 600 lines.
 */
import { projectApi } from "@src/api/http/project";
import { createLogger } from "@src/hooks/logger";
import { STYLE_CONFIG } from "@src/scaffold/ContextMenu/config";
import type { SearchResultItem } from "@src/scaffold/ContextMenu/types";
import type { Session } from "@src/store/session/sessionAtom";
import {
  type SearchResults,
  isNativeSearchAvailable,
  searchFilesNative,
} from "@src/util/platform/tauri/fileSearch";
import { stripPillReferences } from "@src/util/session/stripPillReferences";

const log = createLogger("ContextMenu");

// ── Files ─────────────────────────────────────────────────────────────────────

export async function searchFiles(
  query: string,
  repoPath: string
): Promise<SearchResultItem[]> {
  if (!repoPath || repoPath.trim() === "") return [];
  if (!isNativeSearchAvailable()) return [];

  const searchQuery = query.trim();
  const startedAt = performance.now();
  let results: SearchResults;
  try {
    results = await searchFilesNative({
      root_path: repoPath,
      query: searchQuery,
      max_results: STYLE_CONFIG.searchResultsMaxItems,
    });
  } catch (error) {
    log.warn("[ContextMenu] File search failed for root", {
      repoPath,
      queryLength: searchQuery.length,
      error,
    });
    return [];
  }
  const elapsedMs = Math.round(performance.now() - startedAt);
  if (elapsedMs > 500) {
    log.warn("[ContextMenu] Slow file search", {
      elapsedMs,
      nativeSearchTimeMs: results.search_time_ms,
      totalIndexed: results.total_indexed,
      queryLength: searchQuery.length,
    });
  }

  return [...results.folders, ...results.files];
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export function searchSessions(
  query: string,
  allSessions: Session[]
): SearchResultItem[] {
  const filtered = query.trim()
    ? allSessions.filter(
        (session) =>
          session.user_input?.toLowerCase().includes(query.toLowerCase()) ||
          session.name?.toLowerCase().includes(query.toLowerCase())
      )
    : allSessions;

  const sorted = [...filtered].sort((left, right) => {
    const leftTime = new Date(left.updated_at || left.created_at).getTime();
    const rightTime = new Date(right.updated_at || right.created_at).getTime();
    return rightTime - leftTime;
  });

  return sorted.slice(0, 20).map((session) => {
    const goal = stripPillReferences(
      session.name || session.user_input || "Session"
    );
    const truncatedGoal =
      goal.length > 50 ? goal.substring(0, 47) + "..." : goal;
    return {
      path: session.session_id,
      name: truncatedGoal,
      type: "file" as const,
      iconType: "session" as const,
      agentIconId: session.agentIconId,
      cliAgentType: session.cliAgentType,
      userInput: session.user_input,
    };
  });
}

// ── Projects (with drill-down support) ───────────────────────────────────────

export interface DrilledProject {
  slug: string;
  name: string;
}

export async function searchProjects(
  query: string,
  _effectiveRepoPath: string,
  drilledProject: DrilledProject | null
): Promise<SearchResultItem[]> {
  const lowerQuery = query.trim().toLowerCase();

  if (drilledProject) {
    const allItems: SearchResultItem[] = [];
    const projectDisplayName = drilledProject.name.replace(/^🧑 /, "");
    const matchesProjectSelf =
      !lowerQuery || projectDisplayName.toLowerCase().includes(lowerQuery);

    if (matchesProjectSelf) {
      allItems.push({
        type: "folder" as const,
        path: drilledProject.slug,
        name: drilledProject.name,
        iconType: "project" as const,
      });
    }

    try {
      const workItems = await projectApi.readWorkItems(drilledProject.slug);
      for (const item of workItems) {
        const itemLabel = `${item.frontmatter.short_id}: ${item.frontmatter.title}`;
        const matchesItem =
          !lowerQuery ||
          itemLabel.toLowerCase().includes(lowerQuery) ||
          item.frontmatter.status.toLowerCase().includes(lowerQuery);
        if (matchesItem) {
          allItems.push({
            type: "file" as const,
            path: `${drilledProject.slug}/${item.frontmatter.short_id}`,
            name: itemLabel,
            iconType: "workitem" as const,
          });
        }
      }
    } catch (_err) {
      // Work items may not exist for this project
    }

    return allItems;
  }

  // Not drilled — show project list
  const allItems: SearchResultItem[] = [];
  const personalSlugs = new Set<string>();

  try {
    const personalPath = await projectApi.personalWorkspace();
    const personalProjects = await projectApi.readProjects();
    for (const project of personalProjects) {
      if (project.meta.linked_repos.includes(personalPath)) {
        personalSlugs.add(project.slug);
      }
    }
  } catch (_err) {
    // Personal workspace may not exist
  }

  let projects: Awaited<ReturnType<typeof projectApi.readProjects>> = [];
  try {
    projects = await projectApi.readProjects();
  } catch (_err) {
    // Repo may have no projects
  }

  for (const project of projects) {
    const projectName = project.meta.name || project.slug;
    const isPersonal = personalSlugs.has(project.slug);
    const displayName = isPersonal ? `🧑 ${projectName}` : projectName;
    const matchesProject =
      !lowerQuery || projectName.toLowerCase().includes(lowerQuery);
    if (matchesProject) {
      allItems.push({
        type: "folder" as const,
        path: project.slug,
        name: displayName,
        iconType: "project" as const,
      });
    }
  }

  return allItems;
}

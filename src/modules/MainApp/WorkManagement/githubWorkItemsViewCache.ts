import type { PullRequestListState } from "@src/api/tauri/github";
import { GITHUB_LIST_CACHE_TTL_MS } from "@src/services/git/githubListCache";

export type OpsGitHubViewScope = "issue" | "pr";
export type OpsGitHubQueryState = "all" | "open" | "closed" | "merged";

export interface OpsGitHubViewSnapshot {
  searchQuery: string;
  currentPage: number;
  cachedAt: number;
}

const viewCache = new Map<OpsGitHubViewScope, OpsGitHubViewSnapshot>();

export function getOpsPrListStates(
  state: OpsGitHubQueryState | null
): PullRequestListState[] {
  if (state === "closed" || state === "merged") return ["closed"];
  if (state === "all") return ["open", "closed"];
  return ["open"];
}

export function matchesOpsPrQueryState(
  prState: string,
  queryState: OpsGitHubQueryState | null
): boolean {
  if (queryState === null || queryState === "all") return true;
  if (queryState === "closed") {
    return prState === "closed" || prState === "merged";
  }
  return prState === queryState;
}

/**
 * Retains only the active page/query for each Kanban GitHub surface.
 * The fixed two-entry map has no timers or subscriptions and expires on read.
 */
export function getCachedOpsGitHubView(
  scope: OpsGitHubViewScope
): OpsGitHubViewSnapshot | null {
  const snapshot = viewCache.get(scope);
  if (!snapshot) return null;
  if (Date.now() - snapshot.cachedAt > GITHUB_LIST_CACHE_TTL_MS) {
    viewCache.delete(scope);
    return null;
  }
  return snapshot;
}

export function setCachedOpsGitHubView(
  scope: OpsGitHubViewScope,
  snapshot: Omit<OpsGitHubViewSnapshot, "cachedAt">
): void {
  viewCache.set(scope, { ...snapshot, cachedAt: Date.now() });
}

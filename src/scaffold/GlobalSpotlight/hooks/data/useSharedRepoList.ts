/**
 * useSharedRepoList Hook
 *
 * Single source of truth for repo listing UI across the main Spotlight
 * and the RepoSelector. Handles:
 *   - reading repos from the central repo store (via lightweight useRepoState)
 *   - search filtering
 *   - exposing repoLoading / forceRefresh for write consumers
 *
 * Consumers decide how to render (items adapter, tabs, etc.); this hook
 * only owns the data pipeline.
 */
import { useCallback, useMemo } from "react";

import { useRepoLoader } from "@src/hooks/git/useRepoSelection";
import { useRepoState } from "@src/hooks/git/useRepoState";
import { useFilteredItems } from "@src/hooks/search";

import type { RepoItem } from "../../types";

// ============================================
// Hook Implementation
// ============================================

export function useSharedRepoList(searchQuery: string) {
  const { repos: centralRepos, repoLoading } = useRepoState();
  const { loadRepos: loadReposInternal, forceRefreshRepos } = useRepoLoader();

  const repos: RepoItem[] = useMemo(
    () =>
      centralRepos.map((repo) => ({
        id: repo.id,
        name: repo.name,
        description: repo.description,
        repo_url: repo.repo_url,
        branch: repo.branch,
        fs_uri: repo.fs_uri,
        workspace_uuid: repo.workspace_uuid,
        kind: repo.kind,
      })),
    [centralRepos]
  );

  const { filteredItems: filteredRepos } = useFilteredItems({
    items: repos,
    searchQuery,
    getSearchText: (repo) => repo.name,
  });

  const loadRepos = useCallback(async () => {
    await loadReposInternal();
  }, [loadReposInternal]);

  const refreshReposForce = useCallback(async () => {
    await forceRefreshRepos();
  }, [forceRefreshRepos]);

  return {
    repos,
    filteredRepos,
    repoLoading,
    loadRepos,
    refreshReposForce,
  };
}

export default useSharedRepoList;

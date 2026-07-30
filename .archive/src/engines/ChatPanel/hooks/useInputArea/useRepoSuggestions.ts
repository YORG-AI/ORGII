/**
 * useRepoSuggestions Hook
 *
 * Provides fuzzy-filtered repo and branch suggestions for @ mention autocomplete.
 * Uses useRepoSelection (same source as Spotlight) - all repos the user has added.
 */
import { useCallback, useMemo } from "react";

import { useRepoSelection } from "@src/hooks/git/useRepoSelection";
import { fuzzyMatch, fuzzyScore } from "@src/util/search/fuzzy";

export interface RepoSuggestion {
  id: string;
  name: string;
  path: string;
}

export interface BranchSuggestion {
  name: string;
  /** Format: repoPath|branchName for pill serialization */
  path: string;
}

export interface UseRepoSuggestionsReturn {
  /** All repos (from useRepoSelection) */
  repos: RepoSuggestion[];
  /** Filtered repos matching query, sorted by fuzzy score */
  getFilteredRepos: (query: string) => RepoSuggestion[];
  /** Branches for a repo - requires Tauri get_repo_branches (deferred) */
  getBranchesForRepo: (repoPath: string) => Promise<BranchSuggestion[]>;
}

const MAX_REPO_SUGGESTIONS = 20;

export function useRepoSuggestions(): UseRepoSuggestionsReturn {
  const { repos: centralRepos } = useRepoSelection({ autoLoad: true });

  const repos: RepoSuggestion[] = useMemo(
    () =>
      centralRepos.map((repo) => ({
        id: repo.id,
        name: repo.name,
        path: repo.path ?? repo.fs_uri ?? "",
      })),
    [centralRepos]
  );

  const getFilteredRepos = useCallback(
    (query: string): RepoSuggestion[] => {
      const trimmed = query.trim();
      if (!trimmed) {
        return repos.slice(0, MAX_REPO_SUGGESTIONS);
      }
      const filtered = repos.filter((repo) => fuzzyMatch(trimmed, repo.name));
      return filtered
        .sort(
          (a, b) => fuzzyScore(trimmed, b.name) - fuzzyScore(trimmed, a.name)
        )
        .slice(0, MAX_REPO_SUGGESTIONS);
    },
    [repos]
  );

  const getBranchesForRepo = useCallback(
    async (repoPath: string): Promise<BranchSuggestion[]> => {
      try {
        const { invokeTauri } = await import("@src/util/platform/tauri/init");
        const data = await invokeTauri<{
          branches: Array<{ name: string }>;
        }>("get_repo_branches", { repoPath });
        return (data.branches ?? []).map((branch) => ({
          name: branch.name,
          path: `${repoPath}|${branch.name}`,
        }));
      } catch {
        return [];
      }
    },
    []
  );

  return {
    repos,
    getFilteredRepos,
    getBranchesForRepo,
  };
}

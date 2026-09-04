/**
 * useShortcutData Hook
 *
 * Provides data for shortcut action inputs:
 * - Repositories (from centralized store)
 * - Sessions (from centralized store)
 * - Branches (for a selected repo, with validation)
 */
import { useAtom } from "jotai";
import { useCallback, useMemo, useState } from "react";

import { gitApi } from "@src/api/http/git";
import type { GitBranchInfo } from "@src/api/http/git/types";
import { useSessionManager } from "@src/engines/SessionCore/hooks/session/useSessionManager";
import { useRepoSelection } from "@src/hooks/git/useRepoSelection";
import { createLogger } from "@src/hooks/logger";
import {
  branchCacheAtom,
  getBranchesFromCache,
  isBranchCacheFresh,
  isValidUUID,
  setBranchCacheWithLRU,
} from "@src/store/repo";

const log = createLogger("useShortcutData");

// Types matching CommandCard expectations
export interface RepoItem {
  id: string;
  name: string;
  description?: string;
  repo_url?: string;
  branch?: string;
  fs_uri?: string;
  workspace_uuid?: string;
}

export interface SessionItem {
  session_id: string;
  name: string;
  repo_name: string;
  branch: string;
  status: string;
  is_active: boolean;
}

export interface BranchItem {
  name: string;
  is_current: boolean;
  is_remote: boolean;
}

export interface UseShortcutDataReturn {
  repos: RepoItem[];
  sessions: SessionItem[];
  branches: BranchItem[];
  loadingRepos: boolean;
  loadingSessions: boolean;
  loadingBranches: boolean;
  fetchBranches: (repoId: string) => Promise<void>;
  refreshRepos: () => Promise<void>;
  refreshSessions: () => Promise<void>;
}

export function useShortcutData(): UseShortcutDataReturn {
  // Use centralized repo manager
  const {
    repos: centralRepos,
    repoLoading: loadingRepos,
    loadRepos,
  } = useRepoSelection({ autoLoad: false });

  // Check if a repo ID is valid
  const isRepoValid = useCallback(
    (repoId: string) => centralRepos.some((repo) => repo.id === repoId),
    [centralRepos]
  );

  // Use centralized session manager
  const {
    sessions: centralSessions,
    sessionLoading: loadingSessions,
    loadSessions,
  } = useSessionManager({ autoLoad: false }); // autoLoad: false - sessions already loaded by spotlight/other components

  // Map centralized repos to local format
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
      })),
    [centralRepos]
  );

  // Map centralized sessions to local format
  const sessions: SessionItem[] = useMemo(
    () =>
      centralSessions.map((session) => ({
        session_id: session.session_id,
        name: session.name || "Untitled Session",
        repo_name: session.repo_name || "",
        branch: session.branch || "",
        status: session.status || "unknown",
        is_active:
          session.is_active ||
          session.status === "In Progress" ||
          session.status === "Running",
      })),
    [centralSessions]
  );

  const [branches, setBranches] = useState<BranchItem[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [branchCache, setBranchCache] = useAtom(branchCacheAtom);

  // refreshRepos now triggers centralized refresh
  const refreshRepos = useCallback(async () => {
    await loadRepos();
  }, [loadRepos]);

  // refreshSessions now triggers centralized refresh
  const refreshSessions = useCallback(async () => {
    await loadSessions();
  }, [loadSessions]);

  // Fetch branches for a specific repo (with cache + validation)
  const fetchBranches = useCallback(
    async (repoId: string) => {
      if (!repoId) {
        setBranches([]);
        return;
      }

      // Validate repo ID format
      if (!isValidUUID(repoId)) {
        setBranches([]);
        return;
      }

      // Validate repo exists in centralized store
      if (!isRepoValid(repoId)) {
        setBranches([]);
        return;
      }

      // Check shared branch cache first
      if (isBranchCacheFresh(branchCache, repoId)) {
        const cached = getBranchesFromCache(branchCache, repoId);
        if (cached) {
          const branchList: BranchItem[] = cached.branches.map((branch) => ({
            name: branch.name,
            is_current: branch.isCurrent ?? false,
            is_remote: branch.isRemote ?? false,
          }));
          setBranches(branchList);
          return;
        }
      }

      setLoadingBranches(true);
      try {
        const response = await gitApi.getGitBranches({
          repo_id: repoId,
          include_remote: true,
        });

        // API returns data directly (no status/data wrapper)
        if (response?.branches) {
          const branchList: BranchItem[] = response.branches.map(
            (branchInfo: GitBranchInfo) => ({
              name: branchInfo.name,
              is_current: branchInfo.is_current || false,
              is_remote:
                branchInfo.branch_type === "remote" ||
                branchInfo.name?.startsWith("origin/") ||
                false,
            })
          );

          setBranches(branchList);

          // Update shared branch cache so other consumers benefit
          setBranchCache((prev) =>
            setBranchCacheWithLRU(prev, repoId, {
              branches: branchList.map((branch) => ({
                name: branch.name,
                isCurrent: branch.is_current,
                isRemote: branch.is_remote,
              })),
              currentBranch:
                branchList.find((branch) => branch.is_current)?.name || "",
              fetchedAt: Date.now(),
            })
          );
        }
      } catch (error) {
        log.error("[useShortcutData] Error fetching branches:", error);
        setBranches([]);
      } finally {
        setLoadingBranches(false);
      }
    },
    [isRepoValid, branchCache, setBranchCache]
  );

  // Sessions are auto-loaded by useSessionManager on mount

  return {
    repos,
    sessions,
    branches,
    loadingRepos,
    loadingSessions,
    loadingBranches,
    fetchBranches,
    refreshRepos,
    refreshSessions,
  };
}

export default useShortcutData;

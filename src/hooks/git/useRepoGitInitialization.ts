import { useCallback, useEffect, useState } from "react";

import { repoApi } from "@src/api/tauri/repo";
import { createLogger } from "@src/hooks/logger";

const logger = createLogger("RepoGitInitialization");

export type RepoGitInitializationState = boolean | null;

export interface UseRepoGitInitializationOptions {
  /**
   * GitStatusContext already owns a repo-scoped status snapshot. Reuse its
   * `exists` result while the lightweight initialization check refreshes so a
   * remounted Source Control sidebar does not fall back to a loading screen.
   */
  knownGitStatusExists?: boolean;
}

export interface UseRepoGitInitializationReturn {
  isGitInitialized: RepoGitInitializationState;
  refreshGitInitialization: () => Promise<void>;
}

interface CheckedInitializationState {
  repoPath: string;
  value: boolean;
}

export function useRepoGitInitialization(
  repoPath: string | null | undefined,
  options: UseRepoGitInitializationOptions = {}
): UseRepoGitInitializationReturn {
  const { knownGitStatusExists } = options;
  const [checkedState, setCheckedState] =
    useState<CheckedInitializationState | null>(null);

  const checkedValue =
    repoPath && checkedState?.repoPath === repoPath ? checkedState.value : null;
  // The already-scoped Git status is the authoritative live value. The
  // dedicated check is only a fallback for first load / no-status cases.
  const isGitInitialized = knownGitStatusExists ?? checkedValue ?? null;

  const refreshGitInitialization = useCallback(async () => {
    if (!repoPath) {
      return;
    }

    try {
      const result = await repoApi.checkIsGitRepo(repoPath);
      setCheckedState({ repoPath, value: result });
    } catch (error) {
      logger.warn("Failed to check Git initialization:", error, { repoPath });
      setCheckedState({ repoPath, value: false });
    }
  }, [repoPath]);

  useEffect(() => {
    let cancelled = false;

    async function checkGitInitialization() {
      if (!repoPath) {
        return;
      }

      try {
        const result = await repoApi.checkIsGitRepo(repoPath);
        if (!cancelled) setCheckedState({ repoPath, value: result });
      } catch (error) {
        logger.warn("Failed to check Git initialization:", error, { repoPath });
        if (!cancelled) setCheckedState({ repoPath, value: false });
      }
    }

    void checkGitInitialization();

    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  return { isGitInitialized, refreshGitInitialization };
}

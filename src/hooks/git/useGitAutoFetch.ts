/**
 * useGitAutoFetch Hook
 *
 * Background worker that periodically runs `git fetch` to keep remote
 * tracking refs up-to-date. This ensures the ahead/behind counts shown
 * in the status bar reflect the real remote state.
 *
 * Reads the user's settings via `gitAutoFetchAtom` and
 * `gitAutoFetchIntervalAtom`. When auto-fetch is disabled the hook is
 * a no-op.
 */
import { useAtomValue } from "jotai";
import { useCallback, useRef } from "react";

import { gitApi } from "@src/api/http/git";
import { useGitStatus } from "@src/contexts/git";
import { useVisiblePolling } from "@src/hooks/async";
import { createLogger } from "@src/hooks/logger";
import { selectedRepoAtom, selectedRepoIdAtom } from "@src/store/repo";
import {
  gitAutoFetchAtom,
  gitAutoFetchIntervalAtom,
} from "@src/store/ui/editorSettingsAtom";

const MIN_INTERVAL_MS = 30_000;
const DEFAULT_REMOTE_NAME = "origin";
const logger = createLogger("GitAutoFetch");

export function useGitAutoFetch(): void {
  const autoFetch = useAtomValue(gitAutoFetchAtom);
  const intervalSeconds = useAtomValue(gitAutoFetchIntervalAtom);
  const selectedRepoId = useAtomValue(selectedRepoIdAtom);
  const selectedRepo = useAtomValue(selectedRepoAtom);
  const { forceRefresh, hasActiveRepo } = useGitStatus();

  const activeFetchKeyRef = useRef<string | null>(null);
  const repoPath = selectedRepo?.path || selectedRepo?.fs_uri;

  const fetchKey =
    selectedRepoId && repoPath ? `${selectedRepoId}:${repoPath}` : null;
  const intervalMs = Math.max(intervalSeconds * 1000, MIN_INTERVAL_MS);

  const tick = useCallback(
    async (signal: AbortSignal) => {
      if (!selectedRepoId || !repoPath || !fetchKey) return;
      if (activeFetchKeyRef.current === fetchKey) return;
      activeFetchKeyRef.current = fetchKey;
      try {
        await gitApi.gitFetch({
          repo_id: selectedRepoId,
          repo_path: repoPath,
          remote: DEFAULT_REMOTE_NAME,
          prune: true,
        });
        if (signal.aborted) return;
        await forceRefresh();
      } catch (error) {
        logger.warn("background fetch failed:", error);
      } finally {
        if (activeFetchKeyRef.current === fetchKey) {
          activeFetchKeyRef.current = null;
        }
      }
    },
    [fetchKey, forceRefresh, repoPath, selectedRepoId]
  );

  useVisiblePolling({
    enabled: autoFetch && hasActiveRepo && !!fetchKey,
    intervalMs,
    poll: tick,
  });
}

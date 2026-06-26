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
import { useEffect, useRef } from "react";

import { gitApi } from "@src/api/http/git";
import { useGitStatus } from "@src/contexts/git";
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

  useEffect(() => {
    if (!autoFetch || !hasActiveRepo || !selectedRepoId || !repoPath) return;

    let cancelled = false;
    const fetchKey = `${selectedRepoId}:${repoPath}`;
    const intervalMs = Math.max(intervalSeconds * 1000, MIN_INTERVAL_MS);

    const tick = async () => {
      if (activeFetchKeyRef.current === fetchKey) return;
      activeFetchKeyRef.current = fetchKey;
      try {
        await gitApi.gitFetch({
          repo_id: selectedRepoId,
          repo_path: repoPath,
          remote: DEFAULT_REMOTE_NAME,
          prune: true,
        });
        if (!cancelled) {
          await forceRefresh();
        }
      } catch (error) {
        logger.warn("background fetch failed:", error);
      } finally {
        if (activeFetchKeyRef.current === fetchKey) {
          activeFetchKeyRef.current = null;
        }
      }
    };

    void tick();
    const id = setInterval(() => {
      void tick();
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [
    autoFetch,
    intervalSeconds,
    forceRefresh,
    hasActiveRepo,
    selectedRepoId,
    repoPath,
  ]);
}

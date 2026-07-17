/**
 * useWorkingTreeDiffTotals
 *
 * Fetches the working-tree diff totals (lines added / removed across all
 * changed files — staged, unstaged, and untracked new files via
 * `include_untracked`) for a repo and keeps them fresh via the
 * `repo:status_updated` WebSocket. Used to render `+N -N` badges in the editor
 * status bar's branch pill and the tab-bar `+` menu's Review row.
 *
 * Independent of the Source Control sidebar — the sidebar's numstat lives in
 * component state that only exists while that panel is mounted, so consumers
 * fetch their own aggregate here.
 *
 * The totals are cosmetic: a failed/aborted fetch resolves to zero and never
 * surfaces an error, and fetching is skipped entirely when repoId/repoPath are
 * missing (e.g. the displayed repo isn't the selected one).
 */
import { useCallback, useEffect, useState } from "react";

import { getGitDiffNumstatCombined } from "@src/api/http/git/diff";
import { useRepoStatusListener } from "@src/hooks/git/useRepoStatusListener";
import { useMounted } from "@src/hooks/lifecycle/useMounted";
import {
  DEBOUNCE_DELAYS,
  useDebouncedCallback,
} from "@src/hooks/perf/useDebouncedCallback";

export interface WorkingTreeDiffTotals {
  additions: number;
  deletions: number;
}

const EMPTY_TOTALS: WorkingTreeDiffTotals = { additions: 0, deletions: 0 };

/** Stable key identifying which repo a stored totals value belongs to. */
function repoKeyOf(
  repoId: string | undefined,
  repoPath: string | undefined
): string {
  return repoId && repoPath ? `${repoId} ${repoPath}` : "";
}

export function useWorkingTreeDiffTotals(
  repoId: string | undefined,
  repoPath: string | undefined
): WorkingTreeDiffTotals {
  // Store the fetched totals alongside the repo key they were fetched for.
  // `totals` below is then derived during render, so switching repos shows
  // zero immediately (no stale flash) until the new fetch stamps a match —
  // no reset effect, ref-in-render, or setState-in-render needed.
  const [entry, setEntry] = useState<{
    key: string;
    totals: WorkingTreeDiffTotals;
  }>({ key: "", totals: EMPTY_TOTALS });

  const mountedRef = useMounted();

  // Synchronous function whose setState lives in the promise callback — the
  // shape the `set-state-in-effect` rule sanctions ("setState in a callback
  // when external state changes"), so the effect can call it directly.
  const fetchTotals = useCallback(() => {
    if (!repoId || !repoPath) return;
    const key = repoKeyOf(repoId, repoPath);
    getGitDiffNumstatCombined({
      repo_id: repoId,
      repo_path: repoPath,
      include_untracked: true,
    })
      .then((result) => {
        if (!mountedRef.current) return;
        setEntry({
          key,
          totals: result
            ? {
                additions: result.totalInsertions ?? 0,
                deletions: result.totalDeletions ?? 0,
              }
            : EMPTY_TOTALS,
        });
      })
      .catch(() => {
        // Cosmetic — a failed numstat should never surface an error.
      });
  }, [repoId, repoPath, mountedRef]);

  useEffect(() => {
    fetchTotals();
  }, [fetchTotals]);

  // Coalesce rapid working-tree change events into a single re-fetch.
  const debouncedFetch = useDebouncedCallback(
    () => fetchTotals(),
    DEBOUNCE_DELAYS.API
  );

  useRepoStatusListener(repoId, debouncedFetch);

  const currentKey = repoKeyOf(repoId, repoPath);
  return entry.key === currentKey ? entry.totals : EMPTY_TOTALS;
}

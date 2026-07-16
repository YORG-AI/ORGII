import { useCallback, useState } from "react";

import type { DiffStats } from "@src/api/http/project";
import { useVisiblePolling } from "@src/hooks/async";
import { invokeTauri } from "@src/util/platform/tauri/init";

const POLL_INTERVAL_MS = 10_000;
const DEFAULT_BASE_BRANCH = "main";

interface UseLiveDiffStatsOptions {
  repoPath?: string | null;
  branch?: string;
  isLive: boolean;
}

export function useLiveDiffStats(options: UseLiveDiffStatsOptions) {
  const { repoPath, branch, isLive } = options;

  const [liveDiffStats, setLiveDiffStats] = useState<DiffStats | null>(null);

  const pollDiffStats = useCallback(
    async (signal?: AbortSignal) => {
      if (!repoPath || !branch) return;
      try {
        const stats = await invokeTauri<DiffStats>(
          "orchestrator_get_diff_stats",
          { repoPath, baseBranch: DEFAULT_BASE_BRANCH, workItemBranch: branch }
        );
        if (signal?.aborted) return;
        setLiveDiffStats(stats);
      } catch {
        // git diff may fail if branch doesn't exist yet
      }
    },
    [repoPath, branch]
  );

  useVisiblePolling({
    enabled: isLive && !!repoPath && !!branch,
    intervalMs: POLL_INTERVAL_MS,
    poll: pollDiffStats,
  });

  return liveDiffStats;
}

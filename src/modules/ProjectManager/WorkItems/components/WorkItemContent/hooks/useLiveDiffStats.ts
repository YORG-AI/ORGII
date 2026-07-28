import { useCallback, useEffect, useRef, useState } from "react";

import type { DiffStats } from "@src/api/http/project";
import { parseRawSessionEvent } from "@src/engines/SessionCore/core/schemas";
import { subscribeToSessionEvents } from "@src/engines/SessionCore/sync/useSessionChannel";
import { invokeTauri } from "@src/util/platform/tauri/init";

const EVENT_SETTLE_MS = 500;
const DEFAULT_BASE_BRANCH = "main";

interface UseLiveDiffStatsOptions {
  sessionId?: string | null;
  repoPath?: string | null;
  branch?: string;
  isLive: boolean;
}

export function useLiveDiffStats(options: UseLiveDiffStatsOptions) {
  const { sessionId, repoPath, branch, isLive } = options;

  const [liveDiffStats, setLiveDiffStats] = useState<DiffStats | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pollDiffStats = useCallback(async () => {
    if (!repoPath || !branch) return;
    try {
      const stats = await invokeTauri<DiffStats>(
        "orchestrator_get_diff_stats",
        { repoPath, baseBranch: DEFAULT_BASE_BRANCH, workItemBranch: branch }
      );
      setLiveDiffStats(stats);
    } catch {
      // git diff may fail if branch doesn't exist yet
    }
  }, [repoPath, branch]);

  useEffect(() => {
    if (!isLive || !sessionId) return;
    let cancelled = false;
    const scheduleRefresh = (raw: string) => {
      if (cancelled || document.hidden) return;
      const event = parseRawSessionEvent(raw);
      if (event.type !== "agent:file_change") return;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        if (!cancelled) void pollDiffStats();
      }, EVENT_SETTLE_MS);
    };
    // Defer the initial external read so this effect only establishes the
    // subscription synchronously; the async completion owns the state update.
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      if (!cancelled) void pollDiffStats();
    }, 0);
    const unsubscribe = subscribeToSessionEvents(sessionId, scheduleRefresh);
    return () => {
      cancelled = true;
      unsubscribe();
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [sessionId, isLive, pollDiffStats]);

  return liveDiffStats;
}

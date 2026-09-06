import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import { getTerminalBufferCacheStats } from "@src/engines/TerminalCore/components/TerminalInteractive/bufferCache";
import { createLogger } from "@src/hooks/logger";
import {
  collectWebViewRuntimeDiagnostics,
  getLoadedScriptSourceStats,
  useAppMemorySnapshot,
  useRuntimeRamStats,
} from "@src/hooks/perf";
import { startVisibilityAwarePoller } from "@src/shared/scheduling/visibilityAwarePoller";
import { listRegisteredCaches } from "@src/util/memory/cacheRegistry";

import {
  CHEAP_METRICS_POLL_INTERVAL_MS,
  EMPTY_SNAPSHOT,
  EXPENSIVE_METRICS_POLL_INTERVAL_MS,
} from "./constants";
import type { MemoryBreakdown, MetricsSnapshot, PtyMemoryInfo } from "./types";

const logger = createLogger("SidebarRamMonitor");

export function useRamMonitorMetrics(isOpen: boolean) {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot>(EMPTY_SNAPSHOT);
  const {
    rows: runtimeRows,
    fpsSample,
    fpsValue,
    isSamplingFps,
    refresh: refreshRuntimeStats,
  } = useRuntimeRamStats(false);
  const appMemoryState = useAppMemorySnapshot(isOpen);

  useEffect(() => {
    if (!isOpen) return;
    let disposed = false;
    let generation = 0;
    // In-flight IPC cannot be cancelled, but its result must not publish after
    // hiding, closing, or a subsequent visibility lifecycle.
    const invalidate = () => {
      generation += 1;
    };
    document.addEventListener("visibilitychange", invalidate);
    const isCurrent = (started: number) =>
      !disposed &&
      generation === started &&
      document.visibilityState === "visible";

    const fetchCheapMetrics = async () => {
      const started = generation;
      try {
        const memoryBreakdown = await invoke<MemoryBreakdown>(
          "get_memory_breakdown"
        );
        if (!isCurrent(started)) return;
        refreshRuntimeStats();
        const terminalBufferStats = getTerminalBufferCacheStats();
        const webViewDiagnostics = collectWebViewRuntimeDiagnostics();
        const scriptSources = getLoadedScriptSourceStats();
        const cacheRegistry = listRegisteredCaches();
        setSnapshot((previousSnapshot) => ({
          ...previousSnapshot,
          memoryBreakdown,
          webViewDiagnostics,
          scriptSources,
          terminalBufferBytes: terminalBufferStats.bytes,
          terminalBufferEntries: terminalBufferStats.entries,
          cacheRegistry,
          lastUpdatedAt: Date.now(),
          errorMessage: null,
        }));
      } catch (error) {
        if (!isCurrent(started)) return;
        logger.warn("failed to fetch sidebar RAM metrics", error);
        setSnapshot((previous) => ({
          ...previous,
          errorMessage: error instanceof Error ? error.message : String(error),
        }));
      }
    };
    const fetchExpensiveMetrics = async () => {
      const started = generation;
      try {
        const ptyMemory = await invoke<PtyMemoryInfo[]>(
          "get_pty_memory_usage"
        ).catch(() => []);
        if (!isCurrent(started)) return;
        setSnapshot((previous) => ({
          ...previous,
          ptyMemory,
          lastUpdatedAt: Date.now(),
          errorMessage: null,
        }));
      } catch (error) {
        if (!isCurrent(started)) return;
        logger.warn("failed to fetch expensive sidebar RAM metrics", error);
        setSnapshot((previous) => ({
          ...previous,
          errorMessage: error instanceof Error ? error.message : String(error),
        }));
      }
    };

    const stopCheap = startVisibilityAwarePoller(
      document,
      fetchCheapMetrics,
      CHEAP_METRICS_POLL_INTERVAL_MS
    );
    const stopExpensive = startVisibilityAwarePoller(
      document,
      fetchExpensiveMetrics,
      EXPENSIVE_METRICS_POLL_INTERVAL_MS
    );
    return () => {
      disposed = true;
      stopCheap();
      stopExpensive();
      document.removeEventListener("visibilitychange", invalidate);
    };
  }, [isOpen, refreshRuntimeStats]);

  return {
    snapshot,
    appMemoryState,
    runtimeRows,
    fpsSample,
    fpsValue,
    isSamplingFps,
  };
}

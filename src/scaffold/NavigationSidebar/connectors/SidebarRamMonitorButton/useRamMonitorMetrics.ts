import { invoke } from "@tauri-apps/api/core";
import { useCallback, useMemo, useState } from "react";

import { getTerminalBufferCacheStats } from "@src/components/TerminalInteractive/bufferCache";
import { useVisiblePolling } from "@src/hooks/async";
import {
  collectWebViewRuntimeDiagnostics,
  useRuntimeRamStats,
  useSystemResourceMetrics,
} from "@src/hooks/perf";

import {
  CHEAP_METRICS_POLL_INTERVAL_MS,
  EMPTY_SNAPSHOT,
  EXPENSIVE_METRICS_POLL_INTERVAL_MS,
} from "./constants";
import type { MetricsSnapshot, PtyMemoryInfo } from "./types";

export function useRamMonitorMetrics(isOpen: boolean) {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot>(EMPTY_SNAPSHOT);
  const { snapshot: systemSnapshot } = useSystemResourceMetrics(isOpen);
  const {
    rows: runtimeRows,
    fpsSample,
    fpsValue,
    isSamplingFps,
    refresh: refreshRuntimeStats,
  } = useRuntimeRamStats(false);

  const localSnapshot = useMemo(
    () => ({
      ...snapshot,
      processMetrics: systemSnapshot.processMetrics,
      systemMemory: systemSnapshot.systemMemory,
      memoryBreakdown: systemSnapshot.memoryBreakdown,
      childProcesses: systemSnapshot.childProcesses,
      lastUpdatedAt: systemSnapshot.lastUpdatedAt,
      errorMessage: systemSnapshot.errorMessage,
    }),
    [snapshot, systemSnapshot]
  );

  const refreshLocalMetrics = useCallback(async () => {
    refreshRuntimeStats();
    const terminalBufferStats = getTerminalBufferCacheStats();
    setSnapshot((previousSnapshot) => ({
      ...previousSnapshot,
      webViewDiagnostics: collectWebViewRuntimeDiagnostics(),
      terminalBufferBytes: terminalBufferStats.bytes,
      terminalBufferEntries: terminalBufferStats.entries,
    }));
  }, [refreshRuntimeStats]);

  const refreshPtyMemory = useCallback(async () => {
    const ptyMemory = await invoke<PtyMemoryInfo[]>(
      "get_pty_memory_usage"
    ).catch(() => []);
    setSnapshot((previousSnapshot) => ({
      ...previousSnapshot,
      ptyMemory,
    }));
  }, []);

  useVisiblePolling({
    enabled: isOpen,
    intervalMs: CHEAP_METRICS_POLL_INTERVAL_MS,
    poll: refreshLocalMetrics,
  });
  useVisiblePolling({
    enabled: isOpen,
    intervalMs: EXPENSIVE_METRICS_POLL_INTERVAL_MS,
    poll: refreshPtyMemory,
  });

  return {
    snapshot: localSnapshot,
    runtimeRows,
    fpsSample,
    fpsValue,
    isSamplingFps,
  };
}

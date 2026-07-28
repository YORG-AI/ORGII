import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

import { getTerminalBufferCacheStats } from "@src/components/TerminalInteractive/bufferCache";
import { createLogger } from "@src/hooks/logger";
import {
  collectWebViewRuntimeDiagnostics,
  useAppMemorySnapshot,
  useRuntimeRamStats,
} from "@src/hooks/perf";

import {
  CHEAP_METRICS_POLL_INTERVAL_MS,
  EMPTY_SNAPSHOT,
  EXPENSIVE_METRICS_POLL_INTERVAL_MS,
} from "./constants";
import type { MemoryBreakdown, MetricsSnapshot, PtyMemoryInfo } from "./types";

const logger = createLogger("SidebarRamMonitor");

export function useRamMonitorMetrics(isOpen: boolean) {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot>(EMPTY_SNAPSHOT);
  const lastExpensiveFetchAtRef = useRef(0);
  const {
    rows: runtimeRows,
    fpsSample,
    fpsValue,
    isSamplingFps,
    refresh: refreshRuntimeStats,
  } = useRuntimeRamStats(false);
  const appMemoryState = useAppMemorySnapshot(isOpen);

  const fetchExpensiveMetrics = useCallback(async (force = false) => {
    if (document.visibilityState !== "visible") return;

    const now = Date.now();
    if (
      !force &&
      now - lastExpensiveFetchAtRef.current < EXPENSIVE_METRICS_POLL_INTERVAL_MS
    ) {
      return;
    }
    lastExpensiveFetchAtRef.current = now;

    try {
      const ptyMemory = await invoke<PtyMemoryInfo[]>(
        "get_pty_memory_usage"
      ).catch(() => []);

      setSnapshot((previousSnapshot) => ({
        ...previousSnapshot,
        ptyMemory,
        lastUpdatedAt: Date.now(),
        errorMessage: null,
      }));
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.warn("failed to fetch expensive sidebar RAM metrics", error);
      setSnapshot((previousSnapshot) => ({
        ...previousSnapshot,
        errorMessage,
      }));
    }
  }, []);

  const fetchCheapMetrics = useCallback(async () => {
    if (document.visibilityState !== "visible") return;

    try {
      const memoryBreakdown = await invoke<MemoryBreakdown>(
        "get_memory_breakdown"
      );
      const terminalBufferStats = getTerminalBufferCacheStats();
      const webViewDiagnostics = collectWebViewRuntimeDiagnostics();

      setSnapshot((previousSnapshot) => ({
        ...previousSnapshot,
        memoryBreakdown,
        webViewDiagnostics,
        terminalBufferBytes: terminalBufferStats.bytes,
        terminalBufferEntries: terminalBufferStats.entries,
        lastUpdatedAt: Date.now(),
        errorMessage: null,
      }));
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.warn("failed to fetch sidebar RAM metrics", error);
      setSnapshot((previousSnapshot) => ({
        ...previousSnapshot,
        errorMessage,
      }));
    }
  }, []);

  const refreshAll = useCallback(
    (forceExpensive = false) => {
      refreshRuntimeStats();
      void fetchCheapMetrics();
      void fetchExpensiveMetrics(forceExpensive);
    },
    [fetchCheapMetrics, fetchExpensiveMetrics, refreshRuntimeStats]
  );

  useEffect(() => {
    if (!isOpen) return;

    const frameId = window.requestAnimationFrame(() => refreshAll(true));
    const cheapIntervalId = window.setInterval(
      refreshAll,
      CHEAP_METRICS_POLL_INTERVAL_MS
    );
    const expensiveIntervalId = window.setInterval(
      () => refreshAll(true),
      EXPENSIVE_METRICS_POLL_INTERVAL_MS
    );
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshAll(true);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearInterval(cheapIntervalId);
      window.clearInterval(expensiveIntervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isOpen, refreshAll]);

  return {
    snapshot,
    appMemoryState,
    runtimeRows,
    fpsSample,
    fpsValue,
    isSamplingFps,
  };
}

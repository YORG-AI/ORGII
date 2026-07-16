import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { createLogger } from "@src/hooks/logger";

const log = createLogger("SystemResourceMetrics");

export const SYSTEM_METRICS_CHEAP_INTERVAL_MS = 15_000;
export const SYSTEM_METRICS_EXPENSIVE_INTERVAL_MS = 60_000;

export interface ProcessMetrics {
  memory_rss_mb: number;
  memory_virtual_mb: number;
  cpu_percent: number;
  start_time_secs: number;
  uptime_secs: number;
  pid: number;
  name: string;
}

export interface SystemMemoryMetrics {
  total_mb: number;
  used_mb: number;
  available_mb: number;
  swap_total_mb: number;
  swap_used_mb: number;
}

export interface MemoryBreakdown {
  backend_rss_mb: number;
  tracked_backend_mb: number;
  file_cache_mb: number;
}

export const CHILD_MEMORY_METRIC_KIND = {
  PSS: "pss",
  RSS: "rss",
} as const;

export type ChildMemoryMetricKind =
  (typeof CHILD_MEMORY_METRIC_KIND)[keyof typeof CHILD_MEMORY_METRIC_KIND];

export interface ChildProcessInfo {
  pid: number;
  parent_pid?: number | null;
  name: string;
  memory_mb: number;
  rss_mb: number;
  virtual_memory_mb: number;
  memory_metric_kind: ChildMemoryMetricKind;
  category: string;
  depth?: number;
}

export interface SystemInfo {
  os_name: string;
  os_version: string;
  chip_type: string;
}

export interface SystemResourceMetricsSnapshot {
  processMetrics: ProcessMetrics | null;
  systemMemory: SystemMemoryMetrics | null;
  memoryBreakdown: MemoryBreakdown | null;
  childProcesses: ChildProcessInfo[];
  systemInfo: SystemInfo | null;
  lastUpdatedAt: number | null;
  errorMessage: string | null;
}

const EMPTY_SNAPSHOT: SystemResourceMetricsSnapshot = {
  processMetrics: null,
  systemMemory: null,
  memoryBreakdown: null,
  childProcesses: [],
  systemInfo: null,
  lastUpdatedAt: null,
  errorMessage: null,
};

let snapshot = EMPTY_SNAPSHOT;
const listeners = new Set<() => void>();
let activeConsumerCount = 0;
let cheapTimerId: number | null = null;
let expensiveTimerId: number | null = null;
let cheapRequest: Promise<void> | null = null;
let expensiveRequest: Promise<void> | null = null;

function publish(patch: Partial<SystemResourceMetricsSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function fetchCheapMetrics(): Promise<void> {
  if (cheapRequest) return cheapRequest;

  cheapRequest = Promise.all([
    invoke<ProcessMetrics>("get_process_metrics"),
    invoke<SystemMemoryMetrics>("get_system_memory"),
    invoke<MemoryBreakdown>("get_memory_breakdown").catch(() => null),
    snapshot.systemInfo
      ? Promise.resolve(snapshot.systemInfo)
      : invoke<SystemInfo>("get_system_info").catch(() => null),
  ])
    .then(([processMetrics, systemMemory, memoryBreakdown, systemInfo]) => {
      publish({
        processMetrics,
        systemMemory,
        memoryBreakdown,
        systemInfo,
        lastUpdatedAt: Date.now(),
        errorMessage: null,
      });
    })
    .catch((error: unknown) => {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log.warn("failed to fetch shared system metrics", error);
      publish({ errorMessage });
    })
    .finally(() => {
      cheapRequest = null;
    });

  return cheapRequest;
}

function fetchExpensiveMetrics(): Promise<void> {
  if (expensiveRequest) return expensiveRequest;

  expensiveRequest = invoke<ChildProcessInfo[]>("get_child_processes_memory")
    .then((childProcesses) => {
      publish({
        childProcesses,
        lastUpdatedAt: Date.now(),
        errorMessage: null,
      });
    })
    .catch((error: unknown) => {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log.warn("failed to fetch shared child-process metrics", error);
      publish({ errorMessage });
    })
    .finally(() => {
      expensiveRequest = null;
    });

  return expensiveRequest;
}

export async function refreshSystemResourceMetrics(
  includeExpensive = false
): Promise<void> {
  if (document.visibilityState !== "visible") return;
  await Promise.all([
    fetchCheapMetrics(),
    includeExpensive ? fetchExpensiveMetrics() : Promise.resolve(),
  ]);
}

function stopTimers() {
  if (cheapTimerId !== null) {
    window.clearInterval(cheapTimerId);
    cheapTimerId = null;
  }
  if (expensiveTimerId !== null) {
    window.clearInterval(expensiveTimerId);
    expensiveTimerId = null;
  }
}

function startTimers() {
  if (activeConsumerCount === 0 || document.visibilityState !== "visible") {
    return;
  }
  if (cheapTimerId === null) {
    cheapTimerId = window.setInterval(
      () => void fetchCheapMetrics(),
      SYSTEM_METRICS_CHEAP_INTERVAL_MS
    );
  }
  if (expensiveTimerId === null) {
    expensiveTimerId = window.setInterval(
      () => void fetchExpensiveMetrics(),
      SYSTEM_METRICS_EXPENSIVE_INTERVAL_MS
    );
  }
}

function handleVisibilityChange() {
  if (document.visibilityState === "visible" && activeConsumerCount > 0) {
    void refreshSystemResourceMetrics(true);
    startTimers();
  } else {
    stopTimers();
  }
}

function activateMetricsConsumer(): () => void {
  activeConsumerCount += 1;
  if (activeConsumerCount === 1) {
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void refreshSystemResourceMetrics(true);
    startTimers();
  }

  return () => {
    activeConsumerCount = Math.max(0, activeConsumerCount - 1);
    if (activeConsumerCount === 0) {
      stopTimers();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): SystemResourceMetricsSnapshot {
  return snapshot;
}

const subscribeDisabled = () => () => {};

export function useSystemResourceMetrics(enabled: boolean) {
  const currentSnapshot = useSyncExternalStore(
    enabled ? subscribe : subscribeDisabled,
    getSnapshot,
    getSnapshot
  );

  useEffect(() => {
    if (!enabled) return;
    return activateMetricsConsumer();
  }, [enabled]);

  const refresh = useCallback(
    (includeExpensive = false) =>
      refreshSystemResourceMetrics(includeExpensive),
    []
  );

  return { snapshot: currentSnapshot, refresh };
}

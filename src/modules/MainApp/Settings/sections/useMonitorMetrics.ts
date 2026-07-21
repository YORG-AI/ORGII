/**
 * useMonitorMetrics
 *
 * Encapsulates data fetching, state, and polling lifecycle for MonitorSection.
 * Polls system/process metrics via Tauri invoke commands while the section is
 * visible and the document is in the foreground.
 */
import { invoke } from "@tauri-apps/api/core";
import { useAtomValue, useSetAtom } from "jotai";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { createLogger } from "@src/hooks/logger";
import {
  type AppMemorySnapshotState,
  type ToolProcessMemoryDiagnostic,
  refreshAppMemorySnapshot,
  useAppMemorySnapshot,
} from "@src/hooks/perf";
import {
  monitorActiveTabAtom,
  monitorRefreshTriggerAtom,
  monitorScanningAtom,
  networkRefreshTriggerAtom,
  storageRefreshTriggerAtom,
} from "@src/store";

const log = createLogger("Monitor");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SystemMemoryMetrics {
  total_mb: number;
  used_mb: number;
  available_mb: number;
  swap_total_mb: number;
  swap_used_mb: number;
}

export interface SystemInfo {
  os_name: string;
  os_version: string;
  chip_type: string;
}

// ── Shared utilities ──────────────────────────────────────────────────────────

export interface BreakdownRow {
  key: string;
  label: string;
  megabytes: number;
  totalMb: number;
}

export function formatMemory(megabytes: number): string {
  if (megabytes >= 1024) return (megabytes / 1024).toFixed(2) + " GB";
  return megabytes.toFixed(1) + " MB";
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CHEAP_METRICS_POLL_INTERVAL_MS = 15_000;
const EXPENSIVE_METRICS_POLL_INTERVAL_MS = 60_000;

// ── Hook ──────────────────────────────────────────────────────────────────────

export interface UseMonitorMetricsReturn {
  systemMemory: SystemMemoryMetrics | null;
  appMemoryState: AppMemorySnapshotState;
  toolProcesses: ToolProcessMemoryDiagnostic[];
  systemInfo: SystemInfo | null;
  containerRef: RefObject<HTMLDivElement | null>;
}

export function useMonitorMetrics(activeTab: string): UseMonitorMetricsReturn {
  const [systemMemory, setSystemMemory] = useState<SystemMemoryMetrics | null>(
    null
  );
  const [toolProcesses, setToolProcesses] = useState<
    ToolProcessMemoryDiagnostic[]
  >([]);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [isResourceVisible, setIsResourceVisible] = useState(false);
  const appMemoryState = useAppMemorySnapshot(
    activeTab === "resources" && isResourceVisible
  );

  const setMonitorActiveTab = useSetAtom(monitorActiveTabAtom);
  const setScanning = useSetAtom(monitorScanningAtom);
  const setNetworkTrigger = useSetAtom(networkRefreshTriggerAtom);
  const setStorageTrigger = useSetAtom(storageRefreshTriggerAtom);
  const monitorRefreshTrigger = useAtomValue(monitorRefreshTriggerAtom);

  const containerRef = useRef<HTMLDivElement>(null);
  const cheapIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const expensiveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null
  );
  const lastExpensiveFetchAtRef = useRef(0);
  const isVisibleRef = useRef(false);

  useEffect(() => {
    setMonitorActiveTab(activeTab);
  }, [activeTab, setMonitorActiveTab]);

  const fetchExpensiveMetrics = useCallback(async (force = false) => {
    if (document.visibilityState !== "visible" || !isVisibleRef.current) return;

    const now = Date.now();
    if (
      !force &&
      now - lastExpensiveFetchAtRef.current < EXPENSIVE_METRICS_POLL_INTERVAL_MS
    ) {
      return;
    }
    lastExpensiveFetchAtRef.current = now;

    try {
      const diagnostics = await invoke<ToolProcessMemoryDiagnostic[]>(
        "get_tool_process_memory_diagnostics_v1"
      ).catch(() => []);
      setToolProcesses(diagnostics);
    } catch (error) {
      log.error("failed to fetch expensive monitor metrics:", error);
    }
  }, []);

  const fetchCheapMetrics = useCallback(async () => {
    if (document.visibilityState !== "visible" || !isVisibleRef.current) return;

    try {
      const [system, sysInfo] = await Promise.all([
        invoke<SystemMemoryMetrics>("get_system_memory"),
        invoke<SystemInfo>("get_system_info").catch(() => null),
      ]);
      setSystemMemory(system);
      if (sysInfo) setSystemInfo(sysInfo);
    } catch (error) {
      log.error("failed to fetch monitor metrics:", error);
    }
  }, []);
  const fetchMetrics = useCallback(
    async (forceExpensive = false) => {
      await Promise.all([
        fetchCheapMetrics(),
        fetchExpensiveMetrics(forceExpensive),
      ]);
    },
    [fetchCheapMetrics, fetchExpensiveMetrics]
  );

  const handleRefresh = useCallback(
    async (onSuccess?: () => void) => {
      setScanning(true);
      try {
        await Promise.all([
          fetchMetrics(true),
          activeTab === "resources"
            ? refreshAppMemorySnapshot()
            : Promise.resolve(null),
        ]);
        onSuccess?.();
      } finally {
        setScanning(false);
      }
    },
    [activeTab, fetchMetrics, setScanning]
  );

  useEffect(() => {
    if (monitorRefreshTrigger <= 0) return;
    if (activeTab === "resources") {
      void handleRefresh();
    } else if (activeTab === "network") {
      setNetworkTrigger((prev) => prev + 1);
    } else if (activeTab === "storage") {
      setStorageTrigger((prev) => prev + 1);
    }
  }, [
    monitorRefreshTrigger,
    activeTab,
    handleRefresh,
    setNetworkTrigger,
    setStorageTrigger,
  ]);

  const startPolling = useCallback(() => {
    if (!cheapIntervalRef.current) {
      cheapIntervalRef.current = setInterval(
        fetchCheapMetrics,
        CHEAP_METRICS_POLL_INTERVAL_MS
      );
    }
    if (!expensiveIntervalRef.current) {
      expensiveIntervalRef.current = setInterval(
        () => void fetchExpensiveMetrics(true),
        EXPENSIVE_METRICS_POLL_INTERVAL_MS
      );
    }
  }, [fetchCheapMetrics, fetchExpensiveMetrics]);

  const stopPolling = useCallback(() => {
    if (cheapIntervalRef.current) {
      clearInterval(cheapIntervalRef.current);
      cheapIntervalRef.current = null;
    }
    if (expensiveIntervalRef.current) {
      clearInterval(expensiveIntervalRef.current);
      expensiveIntervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && isVisibleRef.current) {
        void fetchMetrics(true);
        startPolling();
      } else {
        stopPolling();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [fetchMetrics, startPolling, stopPolling]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        isVisibleRef.current = entry.isIntersecting;
        setIsResourceVisible(entry.isIntersecting);
        if (entry.isIntersecting && document.visibilityState === "visible") {
          void fetchMetrics(true);
          startPolling();
        } else {
          stopPolling();
        }
      },
      { threshold: 0 }
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      stopPolling();
    };
  }, [fetchMetrics, startPolling, stopPolling]);

  return {
    systemMemory,
    appMemoryState,
    toolProcesses,
    systemInfo,
    containerRef,
  };
}

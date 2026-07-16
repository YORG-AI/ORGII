/**
 * Shared resource metrics adapter for the Settings monitor surface.
 *
 * The underlying Tauri requests and polling timers are owned by
 * `useSystemResourceMetrics`; this hook only adds section visibility and
 * Settings-specific refresh routing.
 */
import { useAtomValue, useSetAtom } from "jotai";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type ChildProcessInfo,
  type MemoryBreakdown,
  type ProcessMetrics,
  type SystemInfo,
  type SystemMemoryMetrics,
  useSystemResourceMetrics,
} from "@src/hooks/perf";
import {
  monitorActiveTabAtom,
  monitorRefreshTriggerAtom,
  monitorScanningAtom,
  networkRefreshTriggerAtom,
  storageRefreshTriggerAtom,
} from "@src/store";

export { CHILD_MEMORY_METRIC_KIND } from "@src/hooks/perf";
export type {
  ChildMemoryMetricKind,
  ChildProcessInfo,
  MemoryBreakdown,
  ProcessMetrics,
  SystemInfo,
  SystemMemoryMetrics,
} from "@src/hooks/perf";

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

export interface UseMonitorMetricsReturn {
  processMetrics: ProcessMetrics | null;
  systemMemory: SystemMemoryMetrics | null;
  memoryBreakdown: MemoryBreakdown | null;
  childProcesses: ChildProcessInfo[];
  systemInfo: SystemInfo | null;
  containerRef: RefObject<HTMLDivElement | null>;
}

export function useMonitorMetrics(activeTab: string): UseMonitorMetricsReturn {
  const [isSectionVisible, setIsSectionVisible] = useState(false);
  const { snapshot, refresh } = useSystemResourceMetrics(isSectionVisible);
  const setMonitorActiveTab = useSetAtom(monitorActiveTabAtom);
  const setScanning = useSetAtom(monitorScanningAtom);
  const setNetworkTrigger = useSetAtom(networkRefreshTriggerAtom);
  const setStorageTrigger = useSetAtom(storageRefreshTriggerAtom);
  const monitorRefreshTrigger = useAtomValue(monitorRefreshTriggerAtom);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMonitorActiveTab(activeTab);
  }, [activeTab, setMonitorActiveTab]);

  const handleRefresh = useCallback(async () => {
    setScanning(true);
    try {
      await refresh(true);
    } finally {
      setScanning(false);
    }
  }, [refresh, setScanning]);

  useEffect(() => {
    if (monitorRefreshTrigger <= 0) return;
    if (activeTab === "resources") {
      void handleRefresh();
    } else if (activeTab === "network") {
      setNetworkTrigger((previous) => previous + 1);
    } else if (activeTab === "storage") {
      setStorageTrigger((previous) => previous + 1);
    }
  }, [
    activeTab,
    handleRefresh,
    monitorRefreshTrigger,
    setNetworkTrigger,
    setStorageTrigger,
  ]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      ([entry]) => setIsSectionVisible(entry.isIntersecting),
      { threshold: 0 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return {
    processMetrics: snapshot.processMetrics,
    systemMemory: snapshot.systemMemory,
    memoryBreakdown: snapshot.memoryBreakdown,
    childProcesses: snapshot.childProcesses,
    systemInfo: snapshot.systemInfo,
    containerRef,
  };
}

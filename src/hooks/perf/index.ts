/**
 * Performance Hooks
 *
 * Provides React hooks for:
 * - Debouncing callbacks (useDebouncedCallback)
 * - Network monitoring (useNetworkMonitor)
 */

export { useDebouncedCallback, DEBOUNCE_DELAYS } from "./useDebouncedCallback";
export { useNetworkMonitor } from "./useNetworkMonitor";
export {
  formatRuntimeBytes,
  useRuntimeRamStats,
  type RuntimeRamPartRow,
  type UseRuntimeRamStatsResult,
} from "./useRuntimeRamStats";
export {
  SIDEBAR_MEMORY_KIND,
  collectWebViewRuntimeDiagnostics,
  type SidebarMemoryKind,
  type WebViewRuntimeDiagnostics,
} from "./runtimeMemoryStats";
export { useSidebarMemoryEntry } from "./useSidebarMemoryEntry";
export {
  CHILD_MEMORY_METRIC_KIND,
  SYSTEM_METRICS_CHEAP_INTERVAL_MS,
  SYSTEM_METRICS_EXPENSIVE_INTERVAL_MS,
  refreshSystemResourceMetrics,
  useSystemResourceMetrics,
  type ChildMemoryMetricKind,
  type ChildProcessInfo,
  type MemoryBreakdown,
  type ProcessMetrics,
  type SystemInfo,
  type SystemMemoryMetrics,
  type SystemResourceMetricsSnapshot,
} from "./useSystemResourceMetrics";
export type {
  ConnectionStatus,
  GeoInfo,
  ProviderRegion,
  RequestStats,
  UseNetworkMonitorResult,
} from "./useNetworkMonitor";

/**
 * Performance Hooks
 *
 * Provides React hooks for:
 * - Debouncing callbacks (useDebouncedCallback)
 * - Network monitoring (useNetworkMonitor)
 */

export { useDebouncedCallback, DEBOUNCE_DELAYS } from "./useDebouncedCallback";
export { useNetworkMonitor } from "./useNetworkMonitor";
export { formatRuntimeBytes, useRuntimeRamStats } from "./useRuntimeRamStats";
export {
  SIDEBAR_MEMORY_KIND,
  collectWebViewRuntimeDiagnostics,
  type SidebarMemoryKind,
  type WebViewRuntimeDiagnostics,
} from "./runtimeMemoryStats";
export { useSidebarMemoryEntry } from "./useSidebarMemoryEntry";
export {
  describeAppMemoryMeasurement,
  refreshAppMemorySnapshot,
  getAppMemoryMetricKind,
  getAppMemoryRoleLabelKey,
  getAppMemoryTotals,
  useAppMemorySnapshot,
  type AppMemoryProcess,
  type AppMemorySnapshotState,
  type AppMemorySnapshot,
  type ToolProcessMemoryDiagnostic,
} from "./appMemorySnapshot";
export type { ConnectionStatus } from "./useNetworkMonitor";

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";

import { createLogger } from "@src/hooks/logger";

const log = createLogger("AppMemorySnapshot");
const POLL_INTERVAL_MS = 15_000;

export type MemoryMetricKind =
  | "physical_footprint"
  | "private_working_set"
  | "private_bytes"
  | "rss_fallback";

export type EffectiveMeasurement =
  | "native"
  | "compatibility"
  | "mixed"
  | "rss_fallback"
  | "unavailable";

export type AttributionStatus = "complete" | "partial";

export type AppMemoryProcessRole =
  | "backend"
  | "renderer"
  | "gpu"
  | "network"
  | "browser"
  | "utility";

export interface AppMemoryProcess {
  pid: number;
  parent_pid: number | null;
  process_instance_id: string;
  name: string;
  role: AppMemoryProcessRole;
  effective_memory_bytes: number;
  metric_kind: MemoryMetricKind;
  rss_bytes: number;
}

export interface AppMemorySnapshotV1 {
  schema_version: 1;
  captured_at_ms: number;
  processes: AppMemoryProcess[];
  effective_total_bytes: number;
  rss_mapped_total_bytes: number;
  measurement: EffectiveMeasurement;
  attribution: AttributionStatus;
  skipped_ambiguous_pids: number[];
}

export type ToolProcessCategory = "terminal" | "agent_cli" | "mcp_or_tool";

export interface ToolProcessMemoryDiagnostic {
  pid: number;
  parent_pid: number | null;
  process_instance_id: string;
  name: string;
  category: ToolProcessCategory;
  rss_bytes: number;
  virtual_memory_bytes: number;
  depth: number;
}

export interface AppMemorySnapshotState {
  snapshot: AppMemorySnapshotV1 | null;
  errorMessage: string | null;
  isLoading: boolean;
}

export interface AppMemoryTotals {
  totalBytes: number;
  backendBytes: number;
  webviewHelperBytes: number;
}

export function getAppMemoryTotals(
  snapshot: AppMemorySnapshotV1 | null
): AppMemoryTotals {
  const totalBytes = snapshot?.effective_total_bytes ?? 0;
  const backendBytes =
    snapshot?.processes
      .filter((process) => process.role === "backend")
      .reduce((sum, process) => sum + process.effective_memory_bytes, 0) ?? 0;
  return {
    totalBytes,
    backendBytes,
    webviewHelperBytes: Math.max(0, totalBytes - backendBytes),
  };
}

const EMPTY_STATE: AppMemorySnapshotState = {
  snapshot: null,
  errorMessage: null,
  isLoading: false,
};

let state = EMPTY_STATE;
let activeConsumers = 0;
let timeoutId: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<AppMemorySnapshotV1 | null> | null = null;
const listeners = new Set<() => void>();

function emit(nextState: AppMemorySnapshotState): void {
  state = nextState;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): AppMemorySnapshotState {
  return state;
}

function getServerSnapshot(): AppMemorySnapshotState {
  return EMPTY_STATE;
}

export function refreshAppMemorySnapshot(): Promise<AppMemorySnapshotV1 | null> {
  if (inFlight) return inFlight;
  if (
    typeof document !== "undefined" &&
    document.visibilityState !== "visible"
  ) {
    return Promise.resolve(state.snapshot);
  }

  emit({ ...state, isLoading: true });
  inFlight = invoke<AppMemorySnapshotV1>("get_app_memory_snapshot_v1")
    .then((snapshot) => {
      emit({ snapshot, errorMessage: null, isLoading: false });
      return snapshot;
    })
    .catch((error: unknown) => {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log.warn("failed to fetch app-memory snapshot", error);
      emit({ ...state, errorMessage, isLoading: false });
      return null;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function clearScheduledRefresh(): void {
  if (timeoutId === null) return;
  clearTimeout(timeoutId);
  timeoutId = null;
}

async function refreshAndSchedule(): Promise<void> {
  clearScheduledRefresh();
  if (
    activeConsumers === 0 ||
    typeof document === "undefined" ||
    document.visibilityState !== "visible"
  ) {
    return;
  }

  await refreshAppMemorySnapshot();
  if (activeConsumers > 0 && document.visibilityState === "visible") {
    timeoutId = setTimeout(() => {
      timeoutId = null;
      void refreshAndSchedule();
    }, POLL_INTERVAL_MS);
  }
}

function handleVisibilityChange(): void {
  if (document.visibilityState === "visible" && activeConsumers > 0) {
    void refreshAndSchedule();
  } else {
    clearScheduledRefresh();
  }
}

function startPolling(): void {
  if (typeof document === "undefined") return;
  document.addEventListener("visibilitychange", handleVisibilityChange);
  void refreshAndSchedule();
}

function stopPolling(): void {
  clearScheduledRefresh();
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  }
}

function activate(): () => void {
  activeConsumers += 1;
  if (activeConsumers === 1) startPolling();
  return () => {
    activeConsumers = Math.max(0, activeConsumers - 1);
    if (activeConsumers === 0) stopPolling();
  };
}

/**
 * One process-wide frontend store backs both Sidebar and Settings. Multiple
 * consumers share the same in-flight RPC and the same atomic snapshot.
 */
export function useAppMemorySnapshot(enabled: boolean): AppMemorySnapshotState {
  const currentState = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot
  );
  useEffect(() => {
    if (!enabled) return;
    return activate();
  }, [enabled]);
  return currentState;
}

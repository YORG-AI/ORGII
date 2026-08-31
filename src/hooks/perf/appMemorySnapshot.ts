import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";

import { createLogger } from "@src/hooks/logger";

const log = createLogger("AppMemorySnapshot");
const POLL_INTERVAL_MS = 15_000;

/**
 * Headline metric per process — always the value the platform's own task
 * manager shows (Activity Monitor "Memory", Task Manager "Memory", PSS).
 */
export type MemoryMetricKind =
  | "physical_footprint"
  | "private_working_set"
  | "private_bytes"
  | "pss"
  | "rss_fallback";

/** How the resident / swapped split was measured. */
export type MemoryBreakdownKind =
  | "vm_region_walk"
  | "smaps_rollup"
  | "working_set_commit"
  | "unavailable";

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
  /** Physically resident pages private to this process. */
  resident_private_bytes: number;
  /** Resident pages shared with other processes; not summable. */
  resident_shared_bytes: number;
  /** Private pages in the compressor / swap, at uncompressed size. */
  swapped_bytes: number;
  breakdown_kind: MemoryBreakdownKind;
  /** Lifetime peak of `effective_memory_bytes`, when the OS tracks one. */
  peak_effective_memory_bytes: number | null;
}

export interface AppMemorySnapshot {
  schema_version: 2;
  captured_at_ms: number;
  processes: AppMemoryProcess[];
  effective_total_bytes: number;
  rss_mapped_total_bytes: number;
  resident_private_total_bytes: number;
  resident_shared_total_bytes: number;
  swapped_total_bytes: number;
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
  snapshot: AppMemorySnapshot | null;
  errorMessage: string | null;
  isLoading: boolean;
}

export interface AppMemoryTotals {
  /** Headline total — sum of each process's task-manager metric. */
  totalBytes: number;
  backendBytes: number;
  webviewHelperBytes: number;
  /** Physical RAM exclusively held by the app right now. */
  residentPrivateBytes: number;
  /** Diagnostic only; shared pages are counted once per mapping process. */
  residentSharedBytes: number;
  /** Part of the headline that is not in RAM (compressor / swap). */
  swappedBytes: number;
  /** True when at least one process reported a resident / swapped split. */
  hasBreakdown: boolean;
}

export function getAppMemoryTotals(
  snapshot: AppMemorySnapshot | null
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
    residentPrivateBytes: snapshot?.resident_private_total_bytes ?? 0,
    residentSharedBytes: snapshot?.resident_shared_total_bytes ?? 0,
    swappedBytes: snapshot?.swapped_total_bytes ?? 0,
    hasBreakdown:
      snapshot?.processes.some(
        (process) => process.breakdown_kind !== "unavailable"
      ) ?? false,
  };
}

/**
 * The metric kind that describes the headline. The backend process is the
 * reference; helpers normally share its kind, and `measurement` reports when
 * they do not.
 */
export function getAppMemoryMetricKind(
  snapshot: AppMemorySnapshot | null
): MemoryMetricKind | null {
  if (!snapshot || snapshot.processes.length === 0) return null;
  const backend = snapshot.processes.find(
    (process) => process.role === "backend"
  );
  return (backend ?? snapshot.processes[0]).metric_kind;
}

/** Settings-namespace i18n key for a process role label. */
export function getAppMemoryRoleLabelKey(role: AppMemoryProcessRole): string {
  switch (role) {
    case "backend":
      return "monitor.appBackend";
    case "renderer":
      return "monitor.categoryWebview";
    case "gpu":
      return "monitor.categoryGpu";
    case "network":
      return "monitor.categoryNetwork";
    case "browser":
      return "monitor.categoryBrowser";
    case "utility":
      return "monitor.categoryOther";
  }
}

/**
 * Human-readable measurement line: the concrete OS metric first, then any
 * caveat (mixed / fallback metrics, partial attribution).
 */
export function describeAppMemoryMeasurement(
  snapshot: AppMemorySnapshot | null,
  translate: (key: string) => string
): string {
  const metricKind = getAppMemoryMetricKind(snapshot);
  if (!snapshot || metricKind === null) {
    return translate("monitor.measurementKinds.unavailable");
  }
  const parts = [translate(`monitor.metricKinds.${metricKind}`)];
  if (snapshot.measurement !== "native") {
    parts.push(translate(`monitor.measurementKinds.${snapshot.measurement}`));
  }
  if (snapshot.attribution === "partial") {
    parts.push(translate("monitor.attributionPartial"));
  }
  return parts.join(" · ");
}

const EMPTY_STATE: AppMemorySnapshotState = {
  snapshot: null,
  errorMessage: null,
  isLoading: false,
};

let state = EMPTY_STATE;
let activeConsumers = 0;
let timeoutId: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<AppMemorySnapshot | null> | null = null;
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

export function refreshAppMemorySnapshot(): Promise<AppMemorySnapshot | null> {
  if (inFlight) return inFlight;
  if (
    typeof document !== "undefined" &&
    document.visibilityState !== "visible"
  ) {
    return Promise.resolve(state.snapshot);
  }

  emit({ ...state, isLoading: true });
  inFlight = invoke<AppMemorySnapshot>("get_app_memory_snapshot_v1")
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

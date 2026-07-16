import {
  SYSTEM_METRICS_CHEAP_INTERVAL_MS,
  SYSTEM_METRICS_EXPENSIVE_INTERVAL_MS,
} from "@src/hooks/perf";

import type { MetricsSnapshot } from "./types";

export { CHILD_PROCESS_CATEGORY } from "./types";

export const CHEAP_METRICS_POLL_INTERVAL_MS = SYSTEM_METRICS_CHEAP_INTERVAL_MS;
export const EXPENSIVE_METRICS_POLL_INTERVAL_MS =
  SYSTEM_METRICS_EXPENSIVE_INTERVAL_MS;
export const SUCCESS_FPS_THRESHOLD = 40;
export const SUCCESS_RAM_THRESHOLD_MB = 1024;

export const EMPTY_SNAPSHOT: MetricsSnapshot = {
  processMetrics: null,
  systemMemory: null,
  memoryBreakdown: null,
  childProcesses: [],
  ptyMemory: [],
  webViewDiagnostics: null,
  terminalBufferBytes: 0,
  terminalBufferEntries: 0,
  lastUpdatedAt: null,
  errorMessage: null,
};

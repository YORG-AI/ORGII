import type { MetricsSnapshot } from "./types";

export const CHEAP_METRICS_POLL_INTERVAL_MS = 15_000;
export const EXPENSIVE_METRICS_POLL_INTERVAL_MS = 60_000;
export const SUCCESS_FPS_THRESHOLD = 40;
export const SUCCESS_RAM_THRESHOLD_MB = 1024;

export const EMPTY_SNAPSHOT: MetricsSnapshot = {
  memoryBreakdown: null,
  ptyMemory: [],
  webViewDiagnostics: null,
  terminalBufferBytes: 0,
  terminalBufferEntries: 0,
  lastUpdatedAt: null,
  errorMessage: null,
};

/**
 * Download-time estimation + the big-session gate.
 *
 * The listing tells us a session's event count BEFORE any transfer, and the
 * app observes real download rates on every completed import — an EMA of
 * events/second persisted per device turns the two into a pre-download
 * "about N seconds" estimate. Sessions whose estimate exceeds the gate
 * threshold ask the user before an interactive download starts.
 */
const RATE_STORAGE_KEY = "orgii:org2-cloud-v1:downloadRate";

/** Seeded from live dual-instance measurements (4450 events ≈ 12s). */
const DEFAULT_EVENTS_PER_SECOND = 250;
/** Tiny transfers are dominated by fixed latency — not rate signal. */
const MIN_SAMPLE_EVENTS = 100;
/** Fixed pre-download overhead (token refresh, page 1 RTT). */
const FIXED_OVERHEAD_MS = 1_500;
const EMA_ALPHA = 0.3;

/** Interactive downloads estimated above this ask before starting. */
export const CLOUD_DOWNLOAD_GATE_THRESHOLD_MS = 10_000;

function readRate(): number {
  try {
    const raw = localStorage.getItem(RATE_STORAGE_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    if (Number.isFinite(parsed) && parsed > 1) return parsed;
  } catch {
    // Storage unavailable — fall through to the default.
  }
  return DEFAULT_EVENTS_PER_SECOND;
}

/** Feed one completed transfer into the persisted EMA. */
export function recordCloudDownloadSample(
  events: number,
  elapsedMs: number
): void {
  if (events < MIN_SAMPLE_EVENTS || elapsedMs <= 0) return;
  const observed =
    events / Math.max(0.5, (elapsedMs - FIXED_OVERHEAD_MS) / 1000);
  if (!Number.isFinite(observed) || observed <= 1) return;
  const next = readRate() * (1 - EMA_ALPHA) + observed * EMA_ALPHA;
  try {
    localStorage.setItem(RATE_STORAGE_KEY, String(Math.round(next)));
  } catch {
    // Best-effort persistence only.
  }
}

export function estimateCloudDownloadMs(eventCount: number): number {
  if (eventCount <= 0) return 0;
  return Math.round(FIXED_OVERHEAD_MS + (eventCount / readRate()) * 1000);
}

export interface CloudDownloadGateDecision {
  gate: boolean;
  etaMs: number;
}

/** Pure decision (unit-tested): gate when the estimate crosses the line. */
export function decideCloudDownloadGate(
  pendingEvents: number,
  thresholdMs: number = CLOUD_DOWNLOAD_GATE_THRESHOLD_MS
): CloudDownloadGateDecision {
  const etaMs = estimateCloudDownloadMs(pendingEvents);
  return { gate: etaMs > thresholdMs, etaMs };
}

export const __DOWNLOAD_ESTIMATOR_INTERNALS = {
  reset: () => {
    try {
      localStorage.removeItem(RATE_STORAGE_KEY);
    } catch {
      // ignore
    }
  },
};

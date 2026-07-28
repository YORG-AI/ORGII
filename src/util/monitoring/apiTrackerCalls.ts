import {
  getApiCallRecords,
  getTrackingObservationStartedAtMs,
} from "./apiTrackerState";
import type { ApiCall, ApiCallHotspot } from "./apiTrackerTypes";
import {
  effectiveObservationWindowMs,
  ratePerMinuteInWindow,
  spansRepeatedActivity,
} from "./hotspotRates";

function getCallTarget(call: ApiCall): string {
  return call.transport === "tauri"
    ? call.tauriCommand || call.url
    : call.fullUrl;
}

function getHotspotKey(call: ApiCall): string {
  const source = call.filePath
    ? `${call.filePath}:${call.lineNumber ?? 0}`
    : call.componentName || call.functionName || "unknown-source";
  return `${call.transport}:${call.method}:${getCallTarget(call)}:${source}`;
}

export const getApiCalls = (): ApiCall[] => [...getApiCallRecords()];

export function getApiCallHotspots(windowMs = 120_000): ApiCallHotspot[] {
  const now = Date.now();
  const observationWindowMs = effectiveObservationWindowMs(
    windowMs,
    getTrackingObservationStartedAtMs(),
    now
  );
  const recentCalls = getApiCallRecords().filter((call) => {
    const timestamp = new Date(call.timestamp).getTime();
    return Number.isFinite(timestamp) && now - timestamp <= windowMs;
  });

  const grouped = new Map<string, ApiCall[]>();
  for (const call of recentCalls) {
    const key = getHotspotKey(call);
    const group = grouped.get(key);
    if (group) group.push(call);
    else grouped.set(key, [call]);
  }

  return Array.from(grouped.entries())
    .map(([key, calls]) => {
      const sortedCalls = [...calls].sort(
        (callA, callB) =>
          new Date(callB.timestamp).getTime() -
          new Date(callA.timestamp).getTime()
      );
      const latestCall = sortedCalls[0];
      const timestamps = calls.map((call) =>
        new Date(call.timestamp).getTime()
      );
      const firstMs = Math.min(...timestamps);
      const lastMs = Math.max(...timestamps);
      const completedDurations = calls
        .map((call) => call.duration)
        .filter((duration): duration is number => typeof duration === "number");
      const averageDurationMs = completedDurations.length
        ? completedDurations.reduce((sum, duration) => sum + duration, 0) /
          completedDurations.length
        : undefined;
      const callsPerMinute = ratePerMinuteInWindow(
        calls.length,
        observationWindowMs
      );

      return {
        key,
        transport: latestCall.transport,
        method: latestCall.method,
        target: getCallTarget(latestCall),
        count: calls.length,
        callsPerMinute,
        averageDurationMs,
        lastTimestamp: latestCall.timestamp,
        firstTimestamp: new Date(firstMs).toISOString(),
        interactionType: latestCall.interactionType,
        componentName: latestCall.componentName,
        functionName: latestCall.functionName,
        filePath: latestCall.filePath,
        lineNumber: latestCall.lineNumber,
        stack: latestCall.stack,
        isLikelyPolling:
          calls.length >= 3 &&
          latestCall.interactionType === "auto" &&
          spansRepeatedActivity(firstMs, lastMs),
      } satisfies ApiCallHotspot;
    })
    .sort((hotspotA, hotspotB) => {
      if (hotspotA.isLikelyPolling !== hotspotB.isLikelyPolling) {
        return hotspotA.isLikelyPolling ? -1 : 1;
      }
      return hotspotB.callsPerMinute - hotspotA.callsPerMinute;
    });
}

export const getApiCallsForComponent = (
  componentSelector?: string
): ApiCall[] => {
  if (!componentSelector) return getApiCalls();
  return getApiCallRecords().filter(
    (call) => call.componentSelector === componentSelector
  );
};

export const getRecentApiCalls = (limit: number = 20): ApiCall[] =>
  getApiCallRecords().slice(0, limit);

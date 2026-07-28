import type { ApiCall } from "./apiTrackerTypes";

const MAX_API_CALLS = 300;

let apiCalls: ApiCall[] = [];
let trackingEnabled = false;
let trackingObservationStartedAtMs: number | null = null;
let tracingModeEnabled = false;
const requestStartTimes = new Map<string, number>();

export function addApiCall(apiCall: ApiCall): void {
  apiCalls.unshift(apiCall);
  if (apiCalls.length > MAX_API_CALLS) {
    apiCalls = apiCalls.slice(0, MAX_API_CALLS);
  }
}

export function findApiCall(requestId: string): ApiCall | undefined {
  return apiCalls.find((call) => call.id === requestId);
}

export function getApiCallRecords(): readonly ApiCall[] {
  return apiCalls;
}

export function getApiCallCount(): number {
  return apiCalls.length;
}

export function clearApiCallRecords(): void {
  apiCalls = [];
}

export function isTrackingEnabled(): boolean {
  return trackingEnabled;
}

export function enableTrackingState(): void {
  if (!trackingEnabled) trackingObservationStartedAtMs = Date.now();
  trackingEnabled = true;
}

export function disableTrackingState(): void {
  trackingEnabled = false;
}

export function getTrackingObservationStartedAtMs(): number | null {
  return trackingObservationStartedAtMs;
}

export function resetTrackingObservation(): void {
  trackingObservationStartedAtMs = Date.now();
}

export function isTracingEnabled(): boolean {
  return tracingModeEnabled;
}

export function toggleTracingState(): boolean {
  tracingModeEnabled = !tracingModeEnabled;
  return tracingModeEnabled;
}

export function startRequestTiming(requestId: string): void {
  requestStartTimes.set(requestId, Date.now());
}

export function finishRequestTiming(requestId: string): number | undefined {
  const startTime = requestStartTimes.get(requestId);
  const duration = startTime ? Date.now() - startTime : undefined;
  requestStartTimes.delete(requestId);
  return duration;
}

export function clearRequestTimings(): void {
  requestStartTimes.clear();
}

export function dispatchApiCallUpdated(apiCall: ApiCall): void {
  window.dispatchEvent(
    new CustomEvent("api-call-updated", {
      detail: { apiCall, totalCalls: apiCalls.length },
    })
  );
}

export function dispatchApiCallUpdatedIfTracing(apiCall: ApiCall): void {
  if (tracingModeEnabled) dispatchApiCallUpdated(apiCall);
}

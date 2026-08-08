/**
 * Slow safety-net refresh for org policy fields carried by `list_my_orgs`.
 *
 * Realtime intentionally follows only the active org, so an employee parked
 * in Personal (or a different cloud org) cannot receive an inactive org's
 * background-upload policy broadcast. Focus/visibility edges provide the
 * normal catch-up path; one visible-only recursive timeout bounds convergence
 * when the window remains continuously focused. The caller's roster refetch
 * coordinator owns request single-flight and stale-identity rejection.
 */
import { FOCUS_REFRESH_COOLDOWN_MS } from "./org2CloudRealtimeRecovery";

export const ORG2_CLOUD_ROSTER_CONVERGENCE_INTERVAL_MS = 5 * 60_000;

export interface Org2CloudRosterConvergenceOptions {
  refresh: () => Promise<unknown>;
  onError?: (error: unknown) => void;
  intervalMs?: number;
  focusCooldownMs?: number;
}

export function startOrg2CloudRosterConvergence({
  refresh,
  onError,
  intervalMs = ORG2_CLOUD_ROSTER_CONVERGENCE_INTERVAL_MS,
  focusCooldownMs = FOCUS_REFRESH_COOLDOWN_MS,
}: Org2CloudRosterConvergenceOptions): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let lastRefreshAtMs = 0;

  const isVisible = (): boolean => document.visibilityState === "visible";

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const schedule = (): void => {
    clearTimer();
    if (disposed || !isVisible()) return;
    timer = setTimeout(() => {
      timer = null;
      void runRefresh();
    }, intervalMs);
  };

  const runRefresh = (): Promise<void> => {
    if (disposed || !isVisible()) return Promise.resolve();
    clearTimer();
    if (inFlight) return inFlight;

    lastRefreshAtMs = Date.now();
    const request = Promise.resolve()
      .then(refresh)
      .catch((error: unknown) => {
        onError?.(error);
      })
      .then(() => undefined)
      .finally(() => {
        if (inFlight === request) inFlight = null;
        schedule();
      });
    inFlight = request;
    return request;
  };

  // Focus/visible edges are the catch-up path, but alt-tab flapping must not
  // turn each return into a `list_my_orgs`; the 5-min timer still owns the
  // guaranteed convergence cadence.
  const runEdgeRefresh = (): void => {
    if (Date.now() - lastRefreshAtMs < focusCooldownMs) {
      schedule();
      return;
    }
    void runRefresh();
  };

  const handleFocus = (): void => {
    if (isVisible()) runEdgeRefresh();
  };

  const handleVisibilityChange = (): void => {
    if (isVisible()) {
      runEdgeRefresh();
    } else {
      clearTimer();
    }
  };

  window.addEventListener("focus", handleFocus);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  schedule();

  return () => {
    disposed = true;
    clearTimer();
    window.removeEventListener("focus", handleFocus);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}

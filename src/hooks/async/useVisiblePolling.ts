import { useEffect, useRef } from "react";

export interface UseVisiblePollingOptions {
  enabled: boolean;
  intervalMs: number;
  poll: (signal: AbortSignal) => Promise<boolean | void> | boolean | void;
  immediate?: boolean;
  restartKey?: unknown;
}

/**
 * Runs one async poller only while the document is visible.
 *
 * Polls are scheduled after the previous request settles, so a slow backend
 * cannot build up overlapping requests. Each polling episode receives an
 * `AbortSignal`; consumers that mutate state after an `await` must ignore an
 * aborted episode before committing that result. Returning `false` stops the
 * current polling episode until the hook dependencies change.
 */
export function useVisiblePolling({
  enabled,
  intervalMs,
  poll,
  immediate = true,
  restartKey,
}: UseVisiblePollingOptions): void {
  const inFlightRef = useRef<Promise<boolean | void> | null>(null);

  useEffect(() => {
    void restartKey;
    if (!enabled) return;

    let cancelled = false;
    let stopped = false;
    let timerId: number | null = null;
    const abortController = new AbortController();

    const clearTimer = () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
    };

    const runPoll = async () => {
      if (cancelled || stopped || document.visibilityState !== "visible") {
        return;
      }

      const existingRequest = inFlightRef.current;
      if (existingRequest) {
        try {
          await existingRequest;
        } catch {
          // The active polling episode owns error handling.
        }
        if (!cancelled && !stopped && document.visibilityState === "visible") {
          void runPoll();
        }
        return;
      }

      let shouldContinue = true;
      const request = Promise.resolve().then(() =>
        poll(abortController.signal)
      );
      inFlightRef.current = request;
      try {
        shouldContinue = (await request) !== false;
      } catch {
        // A polling failure is transient by default. Callers own user-facing
        // error state; this scheduler keeps the next refresh opportunity alive.
      } finally {
        if (inFlightRef.current === request) {
          inFlightRef.current = null;
        }
      }

      if (!shouldContinue) {
        stopped = true;
        return;
      }
      if (!cancelled && document.visibilityState === "visible") {
        timerId = window.setTimeout(() => {
          timerId = null;
          void runPoll();
        }, intervalMs);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        if (!inFlightRef.current) {
          clearTimer();
          void runPoll();
        }
      } else {
        clearTimer();
      }
    };

    if (document.visibilityState === "visible") {
      if (immediate) {
        void runPoll();
      } else {
        timerId = window.setTimeout(() => {
          timerId = null;
          void runPoll();
        }, intervalMs);
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      abortController.abort();
      clearTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled, immediate, intervalMs, poll, restartKey]);
}

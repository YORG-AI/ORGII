import { invoke } from "@tauri-apps/api/core";
import { type MutableRefObject, useCallback, useEffect } from "react";

export interface UseWebviewUrlPollingParams {
  isWebviewCreated: boolean;
  isVisible: boolean;
  pollInterval: number;
  labelRef: MutableRefObject<string>;
  isDestroyedRef: MutableRefObject<boolean>;
  isUnmountedRef: MutableRefObject<boolean>;
  pollIntervalRef: MutableRefObject<ReturnType<typeof setInterval> | null>;
  lastPolledUrlRef: MutableRefObject<string>;
  setCurrentUrl: (url: string) => void;
  onNavigate?: (url: string) => void;
  log: (...args: unknown[]) => void;
}

export function useWebviewUrlPolling(
  params: UseWebviewUrlPollingParams
): () => Promise<void> {
  const {
    isWebviewCreated,
    isVisible,
    pollInterval,
    labelRef,
    isDestroyedRef,
    isUnmountedRef,
    pollIntervalRef,
    lastPolledUrlRef,
    setCurrentUrl,
    onNavigate,
    log,
  } = params;

  const pollUrl = useCallback(async () => {
    if (!isWebviewCreated || isDestroyedRef.current || isUnmountedRef.current)
      return;

    try {
      const result = await invoke<string | null>("get_webview_url", {
        label: labelRef.current,
      });

      // Re-check after the async invoke — component may have unmounted
      if (isUnmountedRef.current || isDestroyedRef.current) return;

      if (result && result !== lastPolledUrlRef.current) {
        log("URL change detected via polling:", result);
        lastPolledUrlRef.current = result;
        setCurrentUrl(result);
        onNavigate?.(result);
      }
    } catch (err) {
      log("Poll error (may be expected):", err);
    }
  }, [
    isWebviewCreated,
    isDestroyedRef,
    isUnmountedRef,
    labelRef,
    lastPolledUrlRef,
    log,
    onNavigate,
    setCurrentUrl,
  ]);

  useEffect(() => {
    if (!isWebviewCreated || !isVisible || pollInterval <= 0) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      return;
    }

    const INITIAL_POLL_DELAY = 500;
    log(
      "Starting URL polling with interval:",
      pollInterval,
      "after delay:",
      INITIAL_POLL_DELAY
    );

    let cancelled = false;
    let inFlight = false;

    const clearTimer = () => {
      if (!pollIntervalRef.current) return;
      clearTimeout(pollIntervalRef.current);
      pollIntervalRef.current = null;
    };

    const schedule = (delay: number) => {
      clearTimer();
      if (
        cancelled ||
        document.visibilityState !== "visible" ||
        isDestroyedRef.current ||
        isUnmountedRef.current
      ) {
        return;
      }

      pollIntervalRef.current = setTimeout(() => {
        pollIntervalRef.current = null;
        void run();
      }, delay);
    };

    const run = async () => {
      if (cancelled || inFlight || document.visibilityState !== "visible") {
        return;
      }

      inFlight = true;
      try {
        await pollUrl();
      } finally {
        inFlight = false;
        schedule(pollInterval);
      }
    };

    const handleVisibilityChange = () => {
      clearTimer();
      if (document.visibilityState === "visible") {
        void run();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    schedule(INITIAL_POLL_DELAY);

    return () => {
      cancelled = true;
      clearTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    isWebviewCreated,
    isVisible,
    pollInterval,
    log,
    pollIntervalRef,
    pollUrl,
    isDestroyedRef,
    isUnmountedRef,
  ]);

  return pollUrl;
}

import { invoke } from "@tauri-apps/api/core";
import { type MutableRefObject, useCallback } from "react";

import { useVisiblePolling } from "@src/hooks/async";

export interface UseWebviewUrlPollingParams {
  isWebviewCreated: boolean;
  isVisible: boolean;
  pollInterval: number;
  labelRef: MutableRefObject<string>;
  isDestroyedRef: MutableRefObject<boolean>;
  isUnmountedRef: MutableRefObject<boolean>;
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
    lastPolledUrlRef,
    setCurrentUrl,
    onNavigate,
    log,
  } = params;

  const pollUrl = useCallback(
    async (signal?: AbortSignal) => {
      if (!isWebviewCreated || isDestroyedRef.current || isUnmountedRef.current)
        return;

      try {
        const result = await invoke<string | null>("get_webview_url", {
          label: labelRef.current,
        });

        // Re-check after the async invoke — component may have unmounted or
        // started a new polling episode for another webview lifecycle.
        if (signal?.aborted || isUnmountedRef.current || isDestroyedRef.current)
          return;

        if (result && result !== lastPolledUrlRef.current) {
          log("URL change detected via polling:", result);
          lastPolledUrlRef.current = result;
          setCurrentUrl(result);
          onNavigate?.(result);
        }
      } catch (err) {
        log("Poll error (may be expected):", err);
      }
    },
    [
      isWebviewCreated,
      isDestroyedRef,
      isUnmountedRef,
      labelRef,
      lastPolledUrlRef,
      log,
      onNavigate,
      setCurrentUrl,
    ]
  );

  useVisiblePolling({
    enabled: isWebviewCreated && isVisible && pollInterval > 0,
    intervalMs: pollInterval,
    poll: pollUrl,
    immediate: false,
  });

  return pollUrl;
}

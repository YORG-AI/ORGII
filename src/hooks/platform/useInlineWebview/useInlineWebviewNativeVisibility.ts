import { invoke } from "@tauri-apps/api/core";
import { type MutableRefObject, useEffect, useRef } from "react";

export interface UseInlineWebviewNativeVisibilityParams {
  isWebviewCreated: boolean;
  isVisible: boolean;
  isWebviewAvailable: boolean;
  labelRef: MutableRefObject<string>;
  updatePosition: (options?: {
    force?: boolean;
    show?: boolean;
  }) => Promise<void>;
  log: (...args: unknown[]) => void;
}

export function useInlineWebviewNativeVisibility(
  params: UseInlineWebviewNativeVisibilityParams
): void {
  const {
    isWebviewCreated,
    isVisible,
    isWebviewAvailable,
    labelRef,
    updatePosition,
    log,
  } = params;
  const transitionGenerationRef = useRef(0);
  const transitionQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (!isWebviewCreated || !isWebviewAvailable) return;

    const generation = ++transitionGenerationRef.current;

    const handleVisibility = async () => {
      if (generation !== transitionGenerationRef.current) return;

      try {
        if (isVisible) {
          log("Showing WebView (isVisible=true)");
          await updatePosition({ force: true, show: true });
        } else {
          log("Staging WebView offscreen (isVisible=false, but still mounted)");
          await invoke("update_inline_webview_position", {
            label: labelRef.current,
            x: -10000,
            y: -10000,
            width: 1,
            height: 1,
          });
        }
      } catch (err) {
        if (generation === transitionGenerationRef.current) {
          log("Visibility change failed:", err);
        }
      }
    };

    // Native WKWebView mutations are serialized per React owner. A newer
    // visibility intent invalidates queued work before it reaches Tauri, while
    // an already-running mutation is allowed to finish before the latest
    // transition applies the final state.
    transitionQueueRef.current = transitionQueueRef.current
      .catch(() => undefined)
      .then(handleVisibility);

    return () => {
      if (transitionGenerationRef.current === generation) {
        transitionGenerationRef.current += 1;
      }
    };
  }, [
    isWebviewCreated,
    isVisible,
    isWebviewAvailable,
    labelRef,
    updatePosition,
    log,
  ]);
}

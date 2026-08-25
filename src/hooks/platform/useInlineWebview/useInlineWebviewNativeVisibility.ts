import { useEffect } from "react";

export interface UseInlineWebviewNativeVisibilityParams {
  isWebviewCreated: boolean;
  isVisible: boolean;
  isWebviewAvailable: boolean;
  repositionAndShow: () => Promise<boolean>;
  stageOffscreen: (options?: { force?: boolean }) => Promise<void>;
  log: (...args: unknown[]) => void;
}

export function useInlineWebviewNativeVisibility(
  params: UseInlineWebviewNativeVisibilityParams
): void {
  const {
    isWebviewCreated,
    isVisible,
    isWebviewAvailable,
    repositionAndShow,
    stageOffscreen,
    log,
  } = params;

  useEffect(() => {
    if (!isWebviewCreated || !isWebviewAvailable) return;

    let cancelled = false;

    const handleVisibility = async () => {
      try {
        if (isVisible) {
          log("Showing WebView (isVisible=true)");
          await repositionAndShow();
        } else {
          log("Staging WebView offscreen (isVisible=false, but still mounted)");
          await stageOffscreen({ force: true });
        }
      } catch (err) {
        if (!cancelled) {
          log("Visibility change failed:", err);
        }
      }
    };

    void handleVisibility();

    return () => {
      cancelled = true;
    };
  }, [
    isWebviewCreated,
    isVisible,
    isWebviewAvailable,
    repositionAndShow,
    stageOffscreen,
    log,
  ]);
}

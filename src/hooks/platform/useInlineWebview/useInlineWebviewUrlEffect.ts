import { type MutableRefObject, type RefObject, useEffect } from "react";

export interface UseInlineWebviewUrlEffectParams {
  url: string;
  isActive: boolean;
  isWebviewCreated: boolean;
  isWebviewAvailable: boolean;
  createDelay: number;
  containerRef: RefObject<HTMLDivElement | null>;
  getContainerRect: () => DOMRect | null;
  isDestroyedRef: MutableRefObject<boolean>;
  lastRequestedUrlRef: MutableRefObject<string>;
  createWebview: (targetUrl: string) => Promise<void>;
  navigate: (targetUrl: string) => Promise<void>;
  setError: (error: Error | null) => void;
  log: (...args: unknown[]) => void;
}

export function useInlineWebviewUrlEffect(
  params: UseInlineWebviewUrlEffectParams
): void {
  const {
    url,
    isActive,
    isWebviewCreated,
    isWebviewAvailable,
    createDelay,
    containerRef,
    getContainerRect,
    isDestroyedRef,
    lastRequestedUrlRef,
    createWebview,
    navigate,
    setError,
    log,
  } = params;

  useEffect(() => {
    log("WebView creation check:", {
      isWebviewAvailable,
      isActive,
      url,
      isWebviewCreated,
      lastRequestedUrl: lastRequestedUrlRef.current,
      containerExists: !!containerRef.current,
    });

    if (!isWebviewAvailable || !isActive || !url) {
      return;
    }

    if (isWebviewCreated && lastRequestedUrlRef.current === url) {
      log("WebView already exists with same requested URL");
      return;
    }

    if (isWebviewCreated && lastRequestedUrlRef.current !== url) {
      log("WebView exists, navigating to new URL");
      lastRequestedUrlRef.current = url;
      const navTimer = setTimeout(() => {
        void navigate(url);
      }, 0);
      return () => clearTimeout(navTimer);
    }

    isDestroyedRef.current = false;

    const retryTimers: ReturnType<typeof setTimeout>[] = [];
    let cancelled = false;

    const attemptCreate = (retriesLeft: number) => {
      if (isDestroyedRef.current || cancelled) {
        return;
      }

      const rect = getContainerRect();

      if (!rect || rect.width === 0 || rect.height === 0) {
        if (retriesLeft > 0) {
          log("Container has no dimensions, retrying...", { retriesLeft });
          const retryTimer = setTimeout(
            () => attemptCreate(retriesLeft - 1),
            100
          );
          retryTimers.push(retryTimer);
        } else {
          setError(
            new Error("Container has no dimensions - cannot create WebView")
          );
        }
        return;
      }

      void createWebview(url);
    };

    const timer = setTimeout(() => {
      attemptCreate(10);
    }, createDelay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      retryTimers.forEach((retryTimer) => clearTimeout(retryTimer));
    };
  }, [
    url,
    isActive,
    isWebviewCreated,
    isWebviewAvailable,
    createDelay,
    createWebview,
    navigate,
    containerRef,
    getContainerRect,
    log,
    isDestroyedRef,
    lastRequestedUrlRef,
    setError,
  ]);
}

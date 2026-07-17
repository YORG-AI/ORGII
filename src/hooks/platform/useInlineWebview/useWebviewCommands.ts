import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  type MutableRefObject,
  type RefObject,
  useCallback,
  useRef,
} from "react";

import { toNativeFrame } from "@src/util/platform/tauri/nativeFrame";

export interface UseWebviewCommandsParams {
  isWebviewAvailable: boolean;
  isUnmountedRef: RefObject<boolean>;
  containerRef: RefObject<HTMLDivElement | null>;
  labelRef: MutableRefObject<string>;
  userAgent: string;
  incognito: boolean;
  isDestroyedRef: MutableRefObject<boolean>;
  newWindowListenerRef: MutableRefObject<UnlistenFn | null>;
  lastPolledUrlRef: MutableRefObject<string>;
  getContainerRect: () => DOMRect | null;
  log: (...args: unknown[]) => void;
  safeUnlisten: (listenerFn: UnlistenFn | null) => void;
  onCreated?: (webview: Webview) => void;
  onError?: (error: Error) => void;
  onDestroyed?: () => void;
  onNavigate?: (url: string) => void;
  isWebviewCreated: boolean;
  setIsWebviewCreated: (value: boolean) => void;
  setIsLoading: (value: boolean) => void;
  setCurrentUrl: (url: string) => void;
  setError: (error: Error | null) => void;
  isVisible: boolean;
}

export interface UseWebviewCommandsReturn {
  createWebview: (targetUrl: string) => Promise<void>;
  navigate: (targetUrl: string) => Promise<void>;
  reload: () => Promise<void>;
  evaluate: (script: string) => Promise<void>;
  destroy: () => Promise<void>;
}

export function useWebviewCommands(
  params: UseWebviewCommandsParams
): UseWebviewCommandsReturn {
  const {
    isWebviewAvailable,
    isUnmountedRef,
    containerRef,
    labelRef,
    userAgent,
    incognito,
    isDestroyedRef,
    newWindowListenerRef,
    lastPolledUrlRef,
    getContainerRect,
    log,
    safeUnlisten,
    onCreated,
    onError,
    onDestroyed,
    onNavigate,
    isWebviewCreated,
    setIsWebviewCreated,
    setIsLoading,
    setCurrentUrl,
    setError,
    isVisible,
  } = params;

  // Tracks whether this React instance has successfully called create_inline_webview
  // (and therefore incremented the Rust ref-count). Only when this is true should
  // we call close_inline_webview to decrement the ref-count on destroy.
  const hasIncrementedRefCount = useRef(false);
  const lifecycleGenerationRef = useRef(0);

  const createWebview = useCallback(
    async (targetUrl: string) => {
      if (
        !isWebviewAvailable ||
        !containerRef.current ||
        isDestroyedRef.current
      ) {
        log("Cannot create WebView - not available or no container");
        return;
      }

      const rect = getContainerRect();
      if (!rect || rect.width === 0 || rect.height === 0) {
        log("Container has no dimensions, skipping WebView creation");
        return;
      }

      try {
        if (!isUnmountedRef.current) {
          setIsLoading(true);
          setError(null);
        }

        const appWindow = getCurrentWindow();
        const parentLabel = appWindow.label;
        const generation = Math.max(
          lifecycleGenerationRef.current + 1,
          Date.now()
        );
        lifecycleGenerationRef.current = generation;

        log("Creating WebView via Rust command at rect:", rect);

        const frame = toNativeFrame(rect);
        await invoke("create_inline_webview", {
          parentWindow: parentLabel,
          label: labelRef.current,
          url: targetUrl,
          ...frame,
          userAgent: userAgent,
          incognito: incognito,
          generation,
          visible: isVisible,
        });

        // Mark that this instance has a ref-count slot. Even if we are already
        // unmounted at this point we still need to release it.
        hasIncrementedRefCount.current = true;

        // create_inline_webview returns with the webview staged offscreen.
        // Rust uses the generation to prevent stale creates from becoming visible.
        if (isUnmountedRef.current) {
          // Unmounted while create was in-flight. Release the ref-count so the
          // offscreen webview is destroyed without ever being shown.
          void invoke("close_inline_webview", {
            label: labelRef.current,
            generation,
          });
          return;
        }

        setIsWebviewCreated(true);
        setCurrentUrl(targetUrl);
        lastPolledUrlRef.current = targetUrl;

        log("WebView created successfully with label:", labelRef.current);

        const webviewProxy = {
          label: () => labelRef.current,
        } as unknown as Webview;
        onCreated?.(webviewProxy);

        setIsLoading(false);
      } catch (err) {
        if (isUnmountedRef.current) return;
        const error = err instanceof Error ? err : new Error(String(err));
        log("Failed to create WebView:", error);
        setError(error);
        setIsLoading(false);
        onError?.(error);
      }
    },
    [
      isWebviewAvailable,
      isUnmountedRef,
      containerRef,
      getContainerRect,
      userAgent,
      incognito,
      isDestroyedRef,
      labelRef,
      lastPolledUrlRef,
      log,
      isVisible,
      onCreated,
      onError,
      setIsLoading,
      setError,
      setIsWebviewCreated,
      setCurrentUrl,
    ]
  );

  const navigate = useCallback(
    async (targetUrl: string) => {
      log("Navigate to:", targetUrl);

      if (!isWebviewCreated) {
        await createWebview(targetUrl);
        return;
      }

      try {
        if (!isUnmountedRef.current) {
          setIsLoading(true);
        }

        await invoke("navigate_inline_webview", {
          label: labelRef.current,
          url: targetUrl,
        });

        if (isUnmountedRef.current) return;

        setCurrentUrl(targetUrl);
        lastPolledUrlRef.current = targetUrl;
        onNavigate?.(targetUrl);
        setIsLoading(false);
      } catch (err) {
        if (isUnmountedRef.current) return;
        log("Navigation failed, recreating webview:", err);

        // Release our ref-count slot before closing so the Rust registry
        // correctly reflects that this instance no longer holds the webview.
        // createWebview will re-acquire it if recreation succeeds.
        if (hasIncrementedRefCount.current) {
          hasIncrementedRefCount.current = false;
          try {
            await invoke("close_inline_webview", {
              label: labelRef.current,
              generation: lifecycleGenerationRef.current,
            });
          } catch {
            // Ignore close errors during recovery
          }
        }
        setIsWebviewCreated(false);

        await new Promise((resolve) => setTimeout(resolve, 50));
        if (isUnmountedRef.current) return;

        await createWebview(targetUrl);
        onNavigate?.(targetUrl);
      }
    },
    [
      isWebviewCreated,
      createWebview,
      log,
      onNavigate,
      isUnmountedRef,
      labelRef,
      lastPolledUrlRef,
      setIsLoading,
      setCurrentUrl,
      setIsWebviewCreated,
    ]
  );

  const reload = useCallback(async () => {
    if (!isWebviewCreated) return;

    try {
      if (!isUnmountedRef.current) {
        setIsLoading(true);
      }
      log("Reloading inline webview");

      await invoke("reload_inline_webview", {
        label: labelRef.current,
      });

      if (!isUnmountedRef.current) {
        setIsLoading(false);
      }
    } catch (err) {
      if (!isUnmountedRef.current) {
        log("Reload failed:", err);
        setIsLoading(false);
      }
    }
  }, [isWebviewCreated, log, isUnmountedRef, labelRef, setIsLoading]);

  const evaluate = useCallback(
    async (_script: string) => {
      log("evaluate() is not supported in Tauri v2 Webview API");
    },
    [log]
  );

  const destroy = useCallback(async () => {
    // Always send the latest generation to Rust, even if create_inline_webview
    // has not returned yet. Rust records the cancellation and closes the
    // offscreen webview if that late create eventually completes.
    const generation = lifecycleGenerationRef.current;
    if (!hasIncrementedRefCount.current && generation === 0) return;
    hasIncrementedRefCount.current = false;

    if (newWindowListenerRef.current) {
      safeUnlisten(newWindowListenerRef.current);
      newWindowListenerRef.current = null;
    }

    const label = labelRef.current;

    // Move offscreen before closing so the native webview never stays visible
    // while the async close_inline_webview round-trip is in-flight. Avoid
    // calling hide(); WKWebView visibility changes during lifecycle races can
    // poison wry's runtime mutex on macOS.
    void invoke("update_inline_webview_position", {
      label,
      x: -10000,
      y: -10000,
      width: 1,
      height: 1,
    });

    try {
      log("Destroying WebView");
      await invoke("close_inline_webview", {
        label,
        generation,
      });
      isDestroyedRef.current = true;
      if (!isUnmountedRef.current) {
        setIsWebviewCreated(false);
        onDestroyed?.();
      }
    } catch (err) {
      log("Destroy failed:", err);
      isDestroyedRef.current = true;
    }
  }, [
    log,
    onDestroyed,
    safeUnlisten,
    newWindowListenerRef,
    labelRef,
    isDestroyedRef,
    isUnmountedRef,
    setIsWebviewCreated,
  ]);

  return { createWebview, navigate, reload, evaluate, destroy };
}

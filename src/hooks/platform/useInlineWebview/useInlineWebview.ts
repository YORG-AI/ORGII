import type { UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";

import type { UseInlineWebviewOptions, UseInlineWebviewReturn } from "./types";
import { useInlineWebviewNativeVisibility } from "./useInlineWebviewNativeVisibility";
import { useInlineWebviewUrlEffect } from "./useInlineWebviewUrlEffect";
import { useWebviewCommands } from "./useWebviewCommands";
import { useWebviewLayout } from "./useWebviewLayout";
import { useWebviewNewWindowListener } from "./useWebviewNewWindowListener";
import { useWebviewSafeUnlisten } from "./useWebviewSafeUnlisten";
import { useWebviewUrlPolling } from "./useWebviewUrlPolling";
import {
  DEFAULT_POLL_INTERVAL,
  DEFAULT_USER_AGENT,
  IS_TAURI,
} from "./webviewEnv";

export function useInlineWebview(
  options: UseInlineWebviewOptions
): UseInlineWebviewReturn {
  const {
    containerRef,
    url,
    isActive = true,
    isVisible: isVisibleProp,
    userAgent = DEFAULT_USER_AGENT,
    labelPrefix = "webview",
    useExactLabel = false,
    incognito = false,
    createDelay = 100,
    debug = false,
    pollInterval = DEFAULT_POLL_INTERVAL,
    onCreated,
    onDestroyed,
    onNavigate,
    onNewWindow,
    onError,
  } = options;

  const isVisible = isVisibleProp ?? isActive;

  const [isWebviewCreated, setIsWebviewCreated] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [currentUrl, setCurrentUrl] = useState(url);
  const [error, setError] = useState<Error | null>(null);
  const [isWebviewAvailable] = useState(IS_TAURI);

  const labelRef = useRef<string>(
    useExactLabel ? labelPrefix : `${labelPrefix}-${uuidv4()}`
  );
  const isDestroyedRef = useRef(false);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPolledUrlRef = useRef<string>("");
  const lastRequestedUrlRef = useRef<string>("");
  const newWindowListenerRef = useRef<UnlistenFn | null>(null);
  const isUnmountedRef = useRef(false);

  const log = useCallback(
    (..._args: unknown[]) => {
      if (!debug) return;
    },
    [debug]
  );

  const { safeUnlisten } = useWebviewSafeUnlisten();

  useWebviewNewWindowListener({
    isWebviewAvailable,
    labelRef,
    log,
    newWindowListenerRef,
    onNewWindow,
  });

  const { getContainerRect, updatePosition } = useWebviewLayout({
    containerRef,
    isWebviewCreated,
    isWebviewAvailable,
    isVisible,
    labelRef,
    log,
  });

  const pollUrl = useWebviewUrlPolling({
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
  });

  const { createWebview, navigate, reload, evaluate, destroy } =
    useWebviewCommands({
      isWebviewAvailable,
      isUnmountedRef,
      containerRef,
      labelRef,
      userAgent,
      incognito,
      isDestroyedRef,
      pollIntervalRef,
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
    });

  useInlineWebviewNativeVisibility({
    isWebviewCreated,
    isVisible,
    isWebviewAvailable,
    labelRef,
    updatePosition,
    log,
  });

  useInlineWebviewUrlEffect({
    url,
    isActive,
    isWebviewCreated,
    isWebviewAvailable,
    createDelay,
    containerRef,
    isDestroyedRef,
    lastRequestedUrlRef,
    createWebview,
    navigate,
    setError,
    log,
  });

  const destroyRef = useRef(destroy);
  useEffect(() => {
    destroyRef.current = destroy;
  }, [destroy]);

  useEffect(() => {
    isUnmountedRef.current = false;
    return () => {
      isUnmountedRef.current = true;
      void destroyRef.current();
    };
  }, []);

  return {
    isWebviewAvailable,
    isWebviewCreated,
    isLoading,
    currentUrl,
    error,
    navigate,
    reload,
    evaluate,
    destroy,
    updatePosition,
    pollNow: pollUrl,
    webview: null,
  };
}

export default useInlineWebview;

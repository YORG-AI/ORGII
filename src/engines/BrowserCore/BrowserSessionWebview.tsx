/**
 * BrowserSessionWebview
 *
 * Manages a single webview for a browser session.
 * Keeps the webview mounted but hidden when not active.
 */
import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn, listen } from "@tauri-apps/api/event";
import { useAtomValue } from "jotai";
import React, { useCallback, useEffect, useMemo, useRef } from "react";

import { createLogger } from "@src/hooks/logger";
import { useInlineWebview } from "@src/hooks/platform/useInlineWebview";
import { useInlineWebviewOcclusions } from "@src/hooks/platform/useInlineWebview/useInlineWebviewOcclusions";
import { sidebarWidthAtom } from "@src/store/ui/sidebarAtom";
import {
  simulatorPrimarySidebarCollapsedAtom,
  simulatorPrimarySidebarPositionAtom,
  simulatorPrimarySidebarWidthAtom,
} from "@src/store/ui/simulatorAtom";
import { NEW_TAB_TITLE } from "@src/store/workstation/browser/tabs";
import { BrowserSession } from "@src/types/ui/tabs";

const log = createLogger("BrowserSessionWebview");

const ABOUT_BLANK_URL = "about:blank";
const BROWSER_SESSION_LABEL_PREFIX = "browser-session-";

function isBlankBrowserUrl(url?: string): boolean {
  const normalizedUrl = url?.trim().toLowerCase();
  return !normalizedUrl || normalizedUrl.startsWith(ABOUT_BLANK_URL);
}

function getBrowserSessionWebviewLabel(sessionId: string): string {
  return `${BROWSER_SESSION_LABEL_PREFIX}${sessionId}`;
}

interface ActiveInternalBrowserSync {
  browserSessionId: string;
  label: string;
  updatedAt: number;
}

interface InternalBrowserUrlChangedPayload {
  browserSessionId?: string;
  label?: string;
  url: string;
  title?: string;
}

function isInternalBrowserUrlChangedPayload(
  payload: unknown
): payload is InternalBrowserUrlChangedPayload {
  return (
    !!payload &&
    typeof payload === "object" &&
    typeof (payload as InternalBrowserUrlChangedPayload).url === "string"
  );
}

function clearActiveInternalBrowserState(
  sync: ActiveInternalBrowserSync | null,
  reason: string
): void {
  if (!sync) {
    return;
  }

  void invoke("clear_active_internal_browser_state", {
    label: sync.label,
    browserSessionId: sync.browserSessionId,
    reason,
    updatedAt: sync.updatedAt,
  }).catch((error) => {
    log.warn("[BrowserSessionWebview] Failed to clear active state:", error);
  });
}

interface BrowserSessionWebviewProps {
  session: BrowserSession;
  isActive: boolean;
  isTabActive: boolean;
  isSurfaceVisible: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onSessionUpdate: (
    sessionId: string,
    updates: Partial<BrowserSession>
  ) => void;
  onNewTab?: (url: string) => void;
  onPollNow?: () => void;
}

// Helper function to extract title from URL
const getTitleFromUrl = (url: string): string => {
  if (!url) return NEW_TAB_TITLE;
  try {
    const urlObj = new URL(url);
    return urlObj.hostname || NEW_TAB_TITLE;
  } catch {
    return NEW_TAB_TITLE;
  }
};

const BrowserSessionWebview: React.FC<BrowserSessionWebviewProps> = ({
  session,
  isActive,
  isTabActive,
  isSurfaceVisible,
  containerRef,
  onSessionUpdate,
  onNewTab,
  onPollNow,
}) => {
  // Track previous isLoading to detect reload requests
  const prevIsLoadingRef = useRef(session.isLoading);
  const isReloadingRef = useRef(false);
  const activeInternalBrowserSyncRef = useRef<ActiveInternalBrowserSync | null>(
    null
  );
  const webviewLabel = useMemo(
    () => getBrowserSessionWebviewLabel(session.id),
    [session.id]
  );
  const hasNavigableUrl = !isBlankBrowserUrl(session.url);

  const handleSessionNavigation = useCallback(
    (url: string, titleOverride?: string) => {
      if (!isBlankBrowserUrl(url) && url !== session.url) {
        const title = titleOverride?.trim() || getTitleFromUrl(url);
        const newHistory = [
          ...session.history.slice(0, session.historyIndex + 1),
          url,
        ];

        onSessionUpdate(session.id, {
          url,
          title,
          history: newHistory,
          historyIndex: newHistory.length - 1,
          historyEntries: [
            ...(session.historyEntries ?? []),
            { url, title, visitedAt: Date.now() },
          ],
          isLoading: false,
        });
      } else {
        // URL didn't change (same page reload or navigation complete).
        onSessionUpdate(session.id, { isLoading: false });
      }
    },
    [
      onSessionUpdate,
      session.history,
      session.historyEntries,
      session.historyIndex,
      session.id,
      session.url,
    ]
  );

  const webviewConfig = useMemo(() => {
    const shouldActivateWebview = hasNavigableUrl && isActive && isTabActive;
    const shouldShowWebview = shouldActivateWebview && isSurfaceVisible;

    return {
      containerRef,
      url: session.url,
      // Defers native creation for restored/background tabs so old URLs do not
      // replay as live browser pages when the shared Browser host remounts.
      isActive: shouldActivateWebview,
      isVisible: shouldShowWebview,
      // Use exact label (no UUID) so we can predict it for console log polling
      labelPrefix: webviewLabel,
      useExactLabel: true,
      incognito: session.incognito ?? false,
      debug: false,
      // Disable URL polling for inline browser sessions. Calling webview.url()
      // while WKWebView is loading can poison Tauri/wry's runtime mutex on
      // macOS, causing cascading PoisonError panics. We update URL state from
      // explicit navigations instead.
      pollInterval: 0,
      onCreated: () => {
        onSessionUpdate(session.id, { isLoading: false });
      },
      onError: (error: string | Error) => {
        log.error("[BrowserSessionWebview] WebView error:", error);
        clearActiveInternalBrowserState(
          activeInternalBrowserSyncRef.current,
          "browser-session-webview-error"
        );
        activeInternalBrowserSyncRef.current = null;
        onSessionUpdate(session.id, {
          error: typeof error === "string" ? error : error.message,
          isLoading: false,
        });
      },
      onDestroyed: () => {
        clearActiveInternalBrowserState(
          activeInternalBrowserSyncRef.current,
          "browser-session-webview-destroyed"
        );
        activeInternalBrowserSyncRef.current = null;
      },
      onNavigate: (url: string) => {
        handleSessionNavigation(url);
      },
      onNewWindow: (url: string) => {
        if (onNewTab) {
          onNewTab(url);
        }
      },
    };
  }, [
    containerRef,
    hasNavigableUrl,
    handleSessionNavigation,
    session.id,
    session.url,
    session.incognito,
    isActive,
    isTabActive,
    isSurfaceVisible,
    webviewLabel,
    onSessionUpdate,
    onNewTab,
  ]);

  const {
    pollNow,
    updatePosition,
    reload,
    isWebviewAvailable,
    isWebviewCreated,
  } = useInlineWebview(webviewConfig);

  useInlineWebviewOcclusions({
    containerRef,
    isWebviewCreated,
    isSurfaceVisible:
      hasNavigableUrl && isActive && isTabActive && isSurfaceVisible,
    label: webviewLabel,
  });

  useEffect(() => {
    if (!isWebviewAvailable) return;

    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    void listen<InternalBrowserUrlChangedPayload>(
      "internal-browser:url-changed",
      (event) => {
        const payload = event.payload;
        if (!isInternalBrowserUrlChangedPayload(payload)) return;
        if (
          payload.browserSessionId !== session.id &&
          payload.label !== webviewLabel
        ) {
          return;
        }

        handleSessionNavigation(
          payload.url,
          typeof payload.title === "string" ? payload.title : undefined
        );
      }
    )
      .then((listener) => {
        if (cancelled) {
          listener();
          return;
        }
        unlisten = listener;
      })
      .catch((error) => {
        log.warn(
          "[BrowserSessionWebview] Failed to listen for internal browser URL changes:",
          error
        );
      });

    return () => {
      cancelled = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [handleSessionNavigation, isWebviewAvailable, session.id, webviewLabel]);

  useEffect(() => {
    if (!isWebviewAvailable) {
      clearActiveInternalBrowserState(
        activeInternalBrowserSyncRef.current,
        "browser-session-webview-unavailable"
      );
      activeInternalBrowserSyncRef.current = null;
      return;
    }

    const sync: ActiveInternalBrowserSync = {
      browserSessionId: session.id,
      label: webviewLabel,
      updatedAt: Date.now(),
    };
    const shouldSyncActiveState =
      hasNavigableUrl &&
      isActive &&
      isTabActive &&
      isSurfaceVisible &&
      isWebviewCreated;

    if (shouldSyncActiveState) {
      activeInternalBrowserSyncRef.current = sync;
      void invoke("set_active_internal_browser_state", {
        state: {
          browserSessionId: session.id,
          label: webviewLabel,
          url: session.url,
          visible: true,
          updatedAt: sync.updatedAt,
        },
      }).catch((error) => {
        log.warn("[BrowserSessionWebview] Failed to set active state:", error);
      });

      return () => {
        clearActiveInternalBrowserState(
          sync,
          "browser-session-webview-cleanup"
        );
      };
    }

    const previousSync = activeInternalBrowserSyncRef.current;
    activeInternalBrowserSyncRef.current = null;
    clearActiveInternalBrowserState(
      previousSync ?? sync,
      hasNavigableUrl
        ? "browser-session-webview-inactive"
        : "browser-session-webview-blank"
    );
  }, [
    hasNavigableUrl,
    isActive,
    isTabActive,
    isSurfaceVisible,
    isWebviewAvailable,
    isWebviewCreated,
    session.id,
    session.url,
    webviewLabel,
  ]);

  // Handle reload requests: when isLoading goes from false to true
  // and webview already exists, trigger actual reload
  useEffect(() => {
    const wasLoading = prevIsLoadingRef.current;
    const isLoading = session.isLoading;
    prevIsLoadingRef.current = isLoading;

    // Detect reload request: isLoading changed to true and webview already exists
    if (
      !wasLoading &&
      isLoading &&
      isWebviewCreated &&
      !isReloadingRef.current
    ) {
      isReloadingRef.current = true;
      reload()
        .then(() => {
          onSessionUpdate(session.id, { isLoading: false });
        })
        .catch((err) => {
          log.error("[BrowserSessionWebview] Reload failed:", err);
          onSessionUpdate(session.id, { isLoading: false });
        })
        .finally(() => {
          isReloadingRef.current = false;
        });
    }
  }, [
    session.isLoading,
    session.id,
    isWebviewCreated,
    reload,
    onSessionUpdate,
  ]);

  // Watch sidebar layout changes to immediately update webview position.
  // My Station and Agent Station use different sidebar atoms, but both can host
  // the same browser-session webview labels.
  const sidebarWidth = useAtomValue(sidebarWidthAtom);
  const simulatorSidebarCollapsed = useAtomValue(
    simulatorPrimarySidebarCollapsedAtom
  );
  const simulatorSidebarPosition = useAtomValue(
    simulatorPrimarySidebarPositionAtom
  );
  const simulatorSidebarWidth = useAtomValue(simulatorPrimarySidebarWidthAtom);

  useEffect(() => {
    // Trigger position updates during sidebar animation (150ms transition)
    if (isActive && isTabActive) {
      const timers: NodeJS.Timeout[] = [];

      // Update at key intervals during the animation for smooth tracking
      // 0ms (immediate), 50ms, 100ms, and 170ms (after completion)
      [0, 50, 100, 170].forEach((delay) => {
        timers.push(setTimeout(() => updatePosition({ force: true }), delay));
      });

      return () => {
        timers.forEach((timer) => clearTimeout(timer));
      };
    }
  }, [
    sidebarWidth,
    simulatorSidebarCollapsed,
    simulatorSidebarPosition,
    simulatorSidebarWidth,
    isActive,
    isTabActive,
    updatePosition,
  ]);

  // Expose pollNow to parent
  React.useEffect(() => {
    if (onPollNow && isActive) {
      onPollNow();
    }
  }, [onPollNow, isActive]);

  // Store pollNow ref for parent access - update in effect to avoid render-time ref mutation
  const pollNowRef = useRef(pollNow);
  useEffect(() => {
    pollNowRef.current = pollNow;
  }, [pollNow]);

  // Only create webview for sessions with navigable URLs.
  if (!hasNavigableUrl) {
    return null;
  }

  // This component doesn't render anything - the webview overlays the container
  return null;
};

export default BrowserSessionWebview;

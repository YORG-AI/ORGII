/**
 * BrowserSessionWebview
 *
 * Manages a single webview for a browser session.
 * Keeps the webview mounted but hidden when not active.
 */
import { useAtomValue } from "jotai";
import React, { useEffect, useMemo, useRef } from "react";

import { createLogger } from "@src/hooks/logger";
import { useInlineWebview } from "@src/hooks/platform/useInlineWebview";
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

function isBlankBrowserUrl(url?: string): boolean {
  const normalizedUrl = url?.trim().toLowerCase();
  return !normalizedUrl || normalizedUrl.startsWith(ABOUT_BLANK_URL);
}

interface BrowserSessionWebviewProps {
  session: BrowserSession;
  isActive: boolean;
  isTabActive: boolean;
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
  containerRef,
  onSessionUpdate,
  onNewTab,
  onPollNow,
}) => {
  // Track previous isLoading to detect reload requests
  const prevIsLoadingRef = useRef(session.isLoading);
  const isReloadingRef = useRef(false);

  const webviewConfig = useMemo(() => {
    const hasNavigableUrl = !isBlankBrowserUrl(session.url);
    const shouldActivateWebview = hasNavigableUrl && isActive && isTabActive;

    return {
      containerRef,
      url: session.url,
      // Defers native creation for restored/background tabs so old URLs do not
      // replay as live browser pages when the shared Browser host remounts.
      isActive: shouldActivateWebview,
      isVisible: shouldActivateWebview,
      // Use exact label (no UUID) so we can predict it for console log polling
      labelPrefix: `browser-session-${session.id}`,
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
        onSessionUpdate(session.id, {
          error: typeof error === "string" ? error : error.message,
          isLoading: false,
        });
      },
      onNavigate: (url: string) => {
        if (!isBlankBrowserUrl(url) && url !== session.url) {
          const newHistory = [
            ...session.history.slice(0, session.historyIndex + 1),
            url,
          ];

          onSessionUpdate(session.id, {
            url,
            title: getTitleFromUrl(url),
            history: newHistory,
            historyIndex: newHistory.length - 1,
            historyEntries: [
              ...(session.historyEntries ?? []),
              { url, title: getTitleFromUrl(url), visitedAt: Date.now() },
            ],
            isLoading: false,
          });
        } else {
          // URL didn't change (same page reload or navigation complete)
          onSessionUpdate(session.id, { isLoading: false });
        }
      },
      onNewWindow: (url: string) => {
        if (onNewTab) {
          onNewTab(url);
        }
      },
    };
  }, [
    containerRef,
    session.id,
    session.url,
    session.history,
    session.historyIndex,
    session.historyEntries,
    session.incognito,
    isActive,
    isTabActive,
    onSessionUpdate,
    onNewTab,
  ]);

  const { pollNow, updatePosition, reload, isWebviewCreated } =
    useInlineWebview(webviewConfig);

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
  if (isBlankBrowserUrl(session.url)) {
    return null;
  }

  // This component doesn't render anything - the webview overlays the container
  return null;
};

export default BrowserSessionWebview;

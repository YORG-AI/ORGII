/**
 * WebViewport
 *
 * Main viewport for Browser's web browsing mode showing tab bar, URL bar, and webview.
 * Uses the shared TabBar component.
 */
import BrowserCore from "@/src/engines/BrowserCore";
import type { UseBrowserStateReturn } from "@/src/engines/BrowserCore/hooks/useBrowserState";
import { TabBar, type WorkStationTab } from "@/src/modules/WorkStation/shared";
import { useSetAtom } from "jotai";
import { Globe, HatGlasses } from "lucide-react";
import React, { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { EDITOR_TAB_CANVAS_BG_CLASS } from "@src/config/workstation/tokens";
import type { WorkstationTabHeaderHost } from "@src/hooks/workStation";
import { getSiteNameFromUrl } from "@src/store/ui/navigationSidebarTabsAtom";
import {
  closeBrowserTabAtom,
  extractSessionId,
  getBrowserSessionDisplayTitle,
  switchBrowserTabAtom,
  translatePlaceholderBrowserSessionTitle,
} from "@src/store/workstation/browser/tabs";

import { useWebviewScreenshot } from "../../../../hooks/useWebviewScreenshot";
import WebUrlBar, { focusBrowserUrlBar } from "../../components/WebUrlBar";

const ABOUT_BLANK_URL = "about:blank";

function isBlankBrowserUrl(url?: string): boolean {
  const normalizedUrl = url?.trim().toLowerCase();
  return !normalizedUrl || normalizedUrl.startsWith(ABOUT_BLANK_URL);
}

// ============================================
// Types
// ============================================

export interface WebViewportProps {
  /** Browser state from context */
  browserState: UseBrowserStateReturn;
  /** Open native browser DevTools (Safari Inspector / Edge DevTools) */
  onOpenNativeDevTools?: () => void;
  /** Toggle the WorkStation Browser secondary DevTools pane. */
  onToggleDevToolsPane?: () => void;
  /** Whether the WorkStation Browser secondary DevTools pane is collapsed. */
  devToolsPaneCollapsed?: boolean;
  /** Hide the tab bar (when using shared tab bar) */
  hideTabBar?: boolean;
  /** Hide webviews (e.g., when designer mode is active) */
  hideWebviews?: boolean;
  /** Header host to publish the URL bar into. Defaults to My Station Browser. */
  publishUrlBarToHost?: WorkstationTabHeaderHost;
  /** Render the URL bar inline instead of publishing to the Workstation header slot. */
  inlineUrlBar?: boolean;
  /** Whether the element inspector is currently active. */
  isInspectMode?: boolean;
  /** Toggle the element inspector (hover/click to select DOM nodes). */
  onToggleInspectMode?: () => void;
  /**
   * When false, the underlying BrowserCore ignores the global webview-blocked
   * atom (overlays, station-mode switches) and always renders its webviews.
   * Pass false for embedded browser panes that should ignore global overlay
   * blocking. Defaults to true for standalone My Station Browser.
   */
  respectModalBlocking?: boolean;
  /**
   * When false, BrowserCore skips rendering BrowserSessionWebview instances.
   * Defaults to true so this viewport owns visible browser webviews.
   */
  manageWebviews?: boolean;
}

// ============================================
// Main Component
// ============================================

export const WebViewport: React.FC<WebViewportProps> = memo(
  ({
    browserState,
    onOpenNativeDevTools,
    onToggleDevToolsPane,
    devToolsPaneCollapsed = false,
    hideTabBar = false,
    hideWebviews = false,
    publishUrlBarToHost = "browser",
    inlineUrlBar = false,
    isInspectMode = false,
    onToggleInspectMode,
    respectModalBlocking = true,
    manageWebviews = true,
  }) => {
    const {
      sessions,
      activeSessionId,
      setActiveSession,
      closeSession,
      updateSession,
    } = browserState;
    const { t } = useTranslation();

    // Also drive browserTabsAtom so My Station Browser's reverse-sync effect
    // (in useBrowserLayoutState) doesn't forward a stale activeTabId back into
    // BrowserContext and revert this click. Control Tower doesn't read
    // browserTabsAtom for active selection, so this write is a no-op there.
    const switchBrowserTab = useSetAtom(switchBrowserTabAtom);
    const closeBrowserTab = useSetAtom(closeBrowserTabAtom);

    const activeSession = useMemo(
      () => sessions.find((session) => session.id === activeSessionId),
      [sessions, activeSessionId]
    );
    const effectiveActiveSessionId = activeSession?.id ?? activeSessionId;
    const effectiveBrowserState = useMemo(
      () => ({
        ...browserState,
        activeSessionId: effectiveActiveSessionId,
        activeSession,
      }),
      [activeSession, browserState, effectiveActiveSessionId]
    );

    // Convert browser sessions to WorkStationTab format for the tab bar
    const editorTabs: WorkStationTab[] = useMemo(
      () =>
        sessions.map((session) => {
          const displayTitle = getBrowserSessionDisplayTitle(session);
          return {
            id: `browser:${session.id}`,
            type: "browser-session" as const,
            title: translatePlaceholderBrowserSessionTitle(displayTitle, t),
            data: {
              sessionId: session.id,
              url: session.url,
              incognito: session.incognito,
              isLoading: session.isLoading,
            },
            hasUnsavedChanges: false,
          };
        }),
      [sessions, t]
    );

    // Get the active tab ID in WorkStationTab format
    const activeTabId = effectiveActiveSessionId
      ? `browser:${effectiveActiveSessionId}`
      : null;

    // Handle tab click - extract session ID and set active
    const handleTabClick = useCallback(
      (tabId: string) => {
        const sessionId = extractSessionId(tabId);
        // Switch the WorkStation Browser tab strip first so My Station's
        // reverse-sync effect (browserTabsAtom -> BrowserContext) sees the
        // new active tab, then update BrowserContext.
        switchBrowserTab(tabId);
        setActiveSession(sessionId);
      },
      [setActiveSession, switchBrowserTab]
    );

    // Handle tab close - extract session ID and close
    const handleTabClose = useCallback(
      (tabId: string) => {
        const sessionId = extractSessionId(tabId);
        closeBrowserTab(tabId);
        closeSession(sessionId);
      },
      [closeBrowserTab, closeSession]
    );

    // Handle tab reorder (not supported for browser sessions yet)
    const handleTabReorder = useCallback(
      (_startIndex: number, _endIndex: number) => {
        // TODO: Implement session reordering if needed
      },
      []
    );

    const handleNewBrowserTab = useCallback(() => {
      browserState.addSession();
      focusBrowserUrlBar();
    }, [browserState]);

    // Check if can go back/forward based on history
    const canGoBack = useMemo(() => {
      if (!activeSession) return false;
      return (activeSession.historyIndex ?? 0) > 0;
    }, [activeSession]);

    const canGoForward = useMemo(() => {
      if (!activeSession) return false;
      const history = activeSession.history ?? [];
      const historyIndex = activeSession.historyIndex ?? 0;
      return historyIndex < history.length - 1;
    }, [activeSession]);

    // Handle URL navigation
    const handleNavigate = useCallback(
      (url: string) => {
        if (effectiveActiveSessionId && activeSession) {
          // Add to history
          const currentHistory = activeSession.history ?? [];
          const currentIndex = activeSession.historyIndex ?? -1;
          const newHistory = [
            ...currentHistory.slice(0, currentIndex + 1),
            url,
          ];

          updateSession(effectiveActiveSessionId, {
            url,
            isLoading: true,
            history: newHistory,
            historyIndex: newHistory.length - 1,
            historyEntries: [
              ...(activeSession.historyEntries ?? []),
              {
                url,
                title: getSiteNameFromUrl(url),
                visitedAt: Date.now(),
              },
            ],
          });
        }
      },
      [effectiveActiveSessionId, activeSession, updateSession]
    );

    // Handle back navigation
    const handleBack = useCallback(() => {
      if (effectiveActiveSessionId && activeSession && canGoBack) {
        const history = activeSession.history ?? [];
        const newIndex = (activeSession.historyIndex ?? 0) - 1;
        const url = history[newIndex];

        if (url) {
          updateSession(effectiveActiveSessionId, {
            url,
            isLoading: true,
            historyIndex: newIndex,
          });
        }
      }
    }, [effectiveActiveSessionId, activeSession, canGoBack, updateSession]);

    // Handle forward navigation
    const handleForward = useCallback(() => {
      if (effectiveActiveSessionId && activeSession && canGoForward) {
        const history = activeSession.history ?? [];
        const newIndex = (activeSession.historyIndex ?? 0) + 1;
        const url = history[newIndex];

        if (url) {
          updateSession(effectiveActiveSessionId, {
            url,
            isLoading: true,
            historyIndex: newIndex,
          });
        }
      }
    }, [effectiveActiveSessionId, activeSession, canGoForward, updateSession]);

    // Handle reload
    const handleReload = useCallback(() => {
      if (effectiveActiveSessionId && activeSession?.url) {
        updateSession(effectiveActiveSessionId, { isLoading: true });
      }
    }, [effectiveActiveSessionId, activeSession?.url, updateSession]);

    // Handle stop loading
    const handleStop = useCallback(() => {
      if (effectiveActiveSessionId) {
        updateSession(effectiveActiveSessionId, { isLoading: false });
      }
    }, [effectiveActiveSessionId, updateSession]);

    // Screenshot capture: webview label matches BrowserSessionWebview's
    // useExactLabel pattern: `browser-session-${session.id}`.
    const activeWebviewLabel = effectiveActiveSessionId
      ? `browser-session-${effectiveActiveSessionId}`
      : null;
    const { triggerScreenshot, isCapturing } = useWebviewScreenshot({
      webviewLabel: activeWebviewLabel,
    });

    const shouldShowBlankTabPlaceholder =
      !hideWebviews && activeSession && isBlankBrowserUrl(activeSession.url);

    return (
      <div className="flex h-full w-full flex-col overflow-hidden">
        {/* Tab Bar - uses the same component as Code Editor and Database Explorer */}
        {!hideTabBar && editorTabs.length > 0 && (
          <TabBar
            tabs={editorTabs}
            activeTabId={activeTabId}
            onTabClick={handleTabClick}
            onTabClose={handleTabClose}
            onTabReorder={handleTabReorder}
            onNewTab={handleNewBrowserTab}
            repoPath=""
          />
        )}

        {/* URL Bar */}
        {activeSession && (
          <WebUrlBar
            url={activeSession.url || ""}
            isLoading={activeSession.isLoading}
            isIncognito={activeSession.incognito}
            onNavigate={handleNavigate}
            onBack={handleBack}
            onForward={handleForward}
            onReload={handleReload}
            onStop={handleStop}
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            onOpenNativeDevTools={onOpenNativeDevTools}
            onToggleDevToolsPane={onToggleDevToolsPane}
            devToolsPaneCollapsed={devToolsPaneCollapsed}
            onScreenshot={activeSession.url ? triggerScreenshot : undefined}
            isCapturingScreenshot={isCapturing}
            isInspectMode={isInspectMode}
            onToggleInspectMode={onToggleInspectMode}
            publishToHost={publishUrlBarToHost}
            publishEnabled={!hideWebviews}
            inline={inlineUrlBar}
          />
        )}

        {/* Webview Content */}
        <div className="relative flex-1 overflow-hidden">
          <BrowserCore
            browserState={effectiveBrowserState}
            respectModalBlocking={respectModalBlocking}
            manageWebviews={manageWebviews}
            hidden={hideWebviews}
          />
          {shouldShowBlankTabPlaceholder && (
            <div
              className={`absolute inset-0 z-30 flex items-center justify-center p-6 ${EDITOR_TAB_CANVAS_BG_CLASS}`}
            >
              <div className="flex max-w-[400px] flex-col items-center gap-4 text-center">
                {activeSession.incognito ? (
                  <HatGlasses
                    size={64}
                    strokeWidth={1.5}
                    className="text-warning-6 opacity-80"
                  />
                ) : (
                  <Globe
                    size={64}
                    strokeWidth={1.5}
                    className="text-primary-6 opacity-80"
                  />
                )}
                <h3 className="m-0 text-[20px] font-semibold text-text-1">
                  {activeSession.incognito
                    ? t("workstation.browserCore.privateBrowsingEmptyTitle")
                    : t("workstation.browserCore.enterUrlToStart")}
                </h3>
                <p className="m-0 text-[14px] leading-relaxed text-text-2">
                  {t("workstation.browserCore.tlsDevNote")}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }
);

WebViewport.displayName = "WebViewport";

export default WebViewport;

/**
 * useBrowserLayoutState
 *
 * All business logic, effects, and callbacks for BrowserLayout.
 * Keeps the component file pure-rendering.
 *
 * Sub-hooks:
 *   - useBrowserStatusBar  — syncs browser state → global StatusBar atoms
 *   - useBrowserTabSync    — bidirectional sessions ↔ tab strip sync
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import Message from "@src/components/Message";
import { ROUTES } from "@src/config/routes";
import { useBrowserAutomation } from "@src/engines/BrowserCore/hooks/useBrowserAutomation";
import { useWorkStationTabShortcutBridge } from "@src/hooks/tabHost/useWorkStationTabShortcutBridge";
import { useBrowserPaneState } from "@src/modules/WorkStation/Browser/hooks/useBrowserPaneState";
import { useBrowserSessions } from "@src/modules/WorkStation/Browser/hooks/useBrowserSessions";
import { addToAgentAtom } from "@src/store/ui/addToAgentAtom";
import { workStationDevToolsCollapsedPersistAtom } from "@src/store/ui/workStationAtom";
import {
  browserTabsAtom,
  createBrowserSessionTabId,
  extractSessionId,
  isBrowserSessionTab,
} from "@src/store/workstation/browser/tabs";

import { useBrowserStatusBar } from "./useBrowserStatusBar";
import { useBrowserTabSync } from "./useBrowserTabSync";

interface UseBrowserLayoutStateOptions {
  isActive: boolean;
}

export function useBrowserLayoutState({
  isActive,
}: UseBrowserLayoutStateOptions) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const automation = useBrowserAutomation({ enabled: isActive });

  const browser = useBrowserSessions({ enabled: isActive });

  const browserPane = useBrowserPaneState();
  const browserTabsState = useAtomValue(browserTabsAtom);

  const closingSessionIdsRef = useRef<Set<string>>(new Set());
  const browserStateRef = useRef(browser.browserState);

  // Keep browserStateRef current for closures that capture it
  useEffect(() => {
    browserStateRef.current = browser.browserState;
  });

  const setAddToAgent = useSetAtom(addToAgentAtom);

  // ============================================
  // Sub-hooks
  // ============================================

  const setDevToolsCollapsed = useSetAtom(
    workStationDevToolsCollapsedPersistAtom
  );

  const handleToggleDevTools = useCallback(() => {
    setDevToolsCollapsed("toggle");
  }, [setDevToolsCollapsed]);

  useBrowserStatusBar({
    isActive,
    currentUrl: browser.currentUrl,
    isLoading: browser.isLoading,
    errorCount: browser.errorCount,
    warningCount: browser.warningCount,
    devToolsCollapsed: browser.devToolsCollapsed,
    isPrivate: browser.isPrivate,
    sessionCount: browser.sessionCount,
    currentSessionIndex: browser.currentSessionIndex,
    selectedElement: browser.selectedElement,
    primarySidebarCollapsed: browser.primarySidebarCollapsed,
    togglePrimarySidebar: browser.togglePrimarySidebar,
    handleToggleDevTools,
    handlePrevSession: browser.handlePrevSession,
    handleNextSession: browser.handleNextSession,
    clearSelection: browser.clearSelection,
    setAddToAgent,
    toastSuccess: Message.success,
    chatSentToastMessage: t("browser.selectedElement.sentToChat"),
  });

  useBrowserTabSync({
    isActive,
    browserState: browser.browserState,
    browserStateRef,
    closingSessionIdsRef,
  });

  // ============================================
  // Tab handlers
  // ============================================

  const handleCloseSession = useCallback(
    (sessionId: string) => {
      closingSessionIdsRef.current.add(sessionId);
      browserPane.closeTab(createBrowserSessionTabId(sessionId));
      void browser.handleCloseSession(sessionId);
    },
    [browser, browserPane]
  );

  const handleTabClose = useCallback(
    (tabId: string) => {
      if (isBrowserSessionTab(tabId)) {
        handleCloseSession(extractSessionId(tabId));
      } else {
        browserPane.closeTab(tabId);
      }
    },
    [browserPane, handleCloseSession]
  );

  const handleWorkStationCloseActiveBrowserTab = useCallback(() => {
    const tabId = browserTabsState.activeTabId;
    if (tabId) handleTabClose(tabId);
  }, [browserTabsState.activeTabId, handleTabClose]);

  // ⌘T is owned exclusively by the unified `+` menu (TabBarPlusMenu)
  // — Browser mode renders a single-item variant pinned to "New Browser
  // Tab". The bridge still wires ⌘W so the active tab can be closed.
  useWorkStationTabShortcutBridge({
    enabled:
      isActive && location.pathname.startsWith("/orgii/workstation/browser"),
    onCloseActiveTab: handleWorkStationCloseActiveBrowserTab,
  });

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      browser.browserState.setActiveSession(sessionId);
      browserPane.switchToTab(createBrowserSessionTabId(sessionId));
    },
    [browser.browserState, browserPane]
  );

  // ============================================
  // Derived state
  // ============================================

  const activeTab = browserPane.activeTab;
  const hasOpenTabs = browserPane.tabs.length > 0;

  const isShowingBrowserSession = activeTab?.type === "browser-session";

  const hasBrowserSessions = browser.browserState.sessions.length > 0;
  const showBrowserViewport =
    isShowingBrowserSession || (!hasOpenTabs && hasBrowserSessions);

  // ============================================
  // Quick actions + keyboard shortcuts
  // ============================================

  const handleOpenEditor = useCallback(() => {
    navigate(ROUTES.workStation.code.path);
  }, [navigate]);

  // ============================================
  // Tab bar props
  // ============================================

  const tabBarProps = useMemo(
    () => ({
      ...browserPane.tabBarProps,
      paneId: "browser",
      onTabClose: handleTabClose,
      onNewTab: browser.handleNewSession,
    }),
    [browserPane.tabBarProps, handleTabClose, browser.handleNewSession]
  );

  return {
    browser,
    automation,
    activeTab,
    hasOpenTabs,
    tabBarProps,
    isShowingBrowserSession,
    showBrowserViewport,
    hasBrowserSessions,
    handleSelectSession,
    handleCloseSession,
    handleOpenEditor,
    handleToggleDevTools,
  };
}

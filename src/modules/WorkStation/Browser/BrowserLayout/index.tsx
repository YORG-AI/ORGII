/**
 * BrowserLayout
 *
 * Layout orchestrator for Browser mode. Composes:
 * - Left: BrowserPrimarySidebar (sessions + design + settings tabs)
 * - Center: WebViewport (webview)
 * - Right: WebInspector (DevTools) or DOM Editor panel
 * - Bottom: BrowserStatusBar
 *
 * Tab System Architecture:
 * - Uses centralized browserTabsAtom as single source of truth
 * - Browser sessions sync their state to the tab store
 * - All tab switching goes through useBrowserPaneState
 */
import { useAtom, useAtomValue } from "jotai";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";

import { extractSessionId } from "@src/store/workstation/browser/tabs";
import {
  workstationNewBrowserSessionConsumedTickAtom,
  workstationNewBrowserSessionRequestAtom,
} from "@src/store/workstation/workstationTabBarAtoms";

import {
  WORK_STATION_PLACEHOLDER_PAGE_BG_CLASS,
  WorkStationShell,
  buildPrimarySidebarConfig,
  buildSecondaryPanelConfig,
} from "../../shared";
import BrowserPrimarySidebar from "../Panels/BrowserPrimarySidebar";
import {
  type BrowserHostContextValue,
  BrowserHostProvider,
} from "../context/browserHostContext";
import {
  SHARED_BROWSER_HOST,
  SHARED_BROWSER_HOST_SCOPE,
  SharedBrowserDevToolsPanel,
  SharedBrowserWorkspace,
} from "../shared";
import { AgentBrowserOverlay } from "./AgentBrowserOverlay";
import type { BrowserLayoutProps } from "./types";
import { useBrowserLayoutState } from "./useBrowserLayoutState";

export const BrowserLayout: React.FC<BrowserLayoutProps> = memo(
  ({ repoPath, repoName: _repoName, isActive = true }) => {
    const state = useBrowserLayoutState({ isActive });

    const setDevToolsCollapsed = state.browser.setDevToolsCollapsed;
    const handleCloseDevTools = useCallback(() => {
      setDevToolsCollapsed(true);
    }, [setDevToolsCollapsed]);

    const setDevToolsPosition = state.browser.setDevToolsPosition;
    const handleToggleDevToolsPosition = useCallback(() => {
      setDevToolsPosition("toggle");
    }, [setDevToolsPosition]);

    const [devToolsPanelHeight, setDevToolsPanelHeight] = useState(300);

    // Cross-host "New Browser Tab" intent: the unified `+` menu and the
    // Launchpad bump `workstationNewBrowserSessionRequestAtom` via
    // `requestNewBrowserSessionAtom`. We dispatch `addSession(url, isPrivate)`
    // for any request whose tick exceeds the consumed-tick atom — including a
    // request issued before this host mounted (e.g. "New Browser" clicked from
    // the empty Launchpad), which a per-mount ref would have missed. The
    // module-level consumed tick prevents re-firing on a later remount.
    const newSessionRequest = useAtomValue(
      workstationNewBrowserSessionRequestAtom
    );
    const [consumedTick, setConsumedTick] = useAtom(
      workstationNewBrowserSessionConsumedTickAtom
    );
    const addBrowserSession = state.browser.browserState.addSession;
    useEffect(() => {
      if (newSessionRequest.tick > consumedTick) {
        setConsumedTick(newSessionRequest.tick);
        addBrowserSession(newSessionRequest.url, newSessionRequest.isPrivate);
      }
    }, [
      newSessionRequest.tick,
      newSessionRequest.url,
      newSessionRequest.isPrivate,
      consumedTick,
      setConsumedTick,
      addBrowserSession,
    ]);

    // ============================================
    // Primary sidebar config
    // ============================================

    const activeSessionId = state.showBrowserViewport
      ? state.isShowingBrowserSession
        ? extractSessionId(state.activeTab?.id ?? "")
        : state.browser.browserState.activeSessionId
      : null;

    const primarySidebarConfig = useMemo(
      () =>
        buildPrimarySidebarConfig({
          content: (
            <BrowserPrimarySidebar
              sessions={state.browser.browserState.sessions}
              activeSessionId={activeSessionId}
              onSelectSession={state.handleSelectSession}
              onNewSession={state.browser.handleNewSession}
              onNewPrivateSession={state.browser.handleNewPrivateSession}
              onCloseSession={state.handleCloseSession}
              sessionsOnly
            />
          ),
          collapsed: state.browser.primarySidebarCollapsed,
          size: state.browser.primarySidebarWidth,
          onSizeChange: state.browser.setPrimarySidebarWidth,
          onClose: state.browser.closePrimarySidebar,
          onPositionChange: state.browser.setLayoutMode,
          minSize: 180,
          maxSize: 400,
        }),
      [
        state.browser.browserState.sessions,
        activeSessionId,
        state.handleSelectSession,
        state.browser.handleNewSession,
        state.browser.handleNewPrivateSession,
        state.handleCloseSession,
        state.browser.primarySidebarCollapsed,
        state.browser.primarySidebarWidth,
        state.browser.setPrimarySidebarWidth,
        state.browser.closePrimarySidebar,
        state.browser.setLayoutMode,
      ]
    );

    // ============================================
    // Main content
    // ============================================

    const mainContent = (
      <div
        className={`flex h-full min-h-0 w-full flex-col overflow-hidden ${WORK_STATION_PLACEHOLDER_PAGE_BG_CLASS}`}
      >
        <div className="relative flex-1 overflow-hidden">
          {(!state.hasOpenTabs || state.hasBrowserSessions) && (
            <div
              className={`absolute inset-0 ${
                (state.showBrowserViewport || !state.hasOpenTabs) &&
                !state.automation.isRunning
                  ? "pointer-events-auto visible"
                  : "pointer-events-none invisible"
              }`}
            >
              <SharedBrowserWorkspace
                hostId={SHARED_BROWSER_HOST.MY_STATION}
                scope={SHARED_BROWSER_HOST_SCOPE.MY_STATION}
                active={
                  isActive &&
                  state.showBrowserViewport &&
                  !state.automation.isRunning
                }
                browserState={state.browser.browserState}
                onOpenNativeDevTools={state.browser.handleOpenNativeDevTools}
                onToggleDevToolsPane={state.browser.handleToggleDevTools}
                devToolsPaneCollapsed={state.browser.devToolsCollapsed}
                hideWebviews={!isActive || !state.showBrowserViewport}
                webviewBottomInsetPx={0}
                isInspectMode={state.browser.isInspectMode}
                onToggleInspectMode={state.browser.toggleInspectMode}
              />
            </div>
          )}

          {state.automation.isRunning && (
            <AgentBrowserOverlay
              screenshot={state.automation.lastScreenshot}
              action={state.automation.lastAction}
              url={state.automation.currentUrl}
              isPaused={state.automation.isPaused}
              onTakeover={state.automation.takeover}
              onResume={state.automation.resume}
              onStop={state.automation.stop}
            />
          )}
        </div>
      </div>
    );

    // ============================================
    // DevTools panel — routed to right or bottom based on position
    // ============================================

    const devToolsPosition = state.browser.devToolsPosition;

    const devToolsContent = useMemo(
      () => (
        <SharedBrowserDevToolsPanel
          isCollapsed={state.browser.devToolsCollapsed}
          onToggleCollapse={state.browser.handleToggleDevTools}
          width={state.browser.devToolsPanelWidth}
          onWidthChange={state.browser.setDevToolsPanelWidth}
          entries={state.browser.entries}
          onClearEntries={state.browser.clearEntries}
          networkEntries={state.browser.networkEntries}
          onClearNetworkEntries={state.browser.clearNetworkEntries}
          errorCount={state.browser.errorCount}
          warningCount={state.browser.warningCount}
          selectedElement={state.browser.selectedElement}
          webviewLabel={state.browser.activeWebviewLabel}
          repoPath={repoPath}
          currentUrl={state.browser.currentUrl}
          position={devToolsPosition}
          onTogglePosition={handleToggleDevToolsPosition}
        />
      ),
      [
        state.browser.devToolsCollapsed,
        state.browser.handleToggleDevTools,
        state.browser.devToolsPanelWidth,
        state.browser.setDevToolsPanelWidth,
        state.browser.entries,
        state.browser.clearEntries,
        state.browser.networkEntries,
        state.browser.clearNetworkEntries,
        state.browser.errorCount,
        state.browser.warningCount,
        state.browser.selectedElement,
        state.browser.activeWebviewLabel,
        state.browser.currentUrl,
        repoPath,
        devToolsPosition,
        handleToggleDevToolsPosition,
      ]
    );

    // Secondary panel config — single mount, CSS grid relocates right/bottom.
    // Size/handler are axis-appropriate: width for right, height for bottom.
    const secondaryPanelConfig = useMemo(
      () =>
        buildSecondaryPanelConfig({
          content: devToolsContent,
          position: devToolsPosition,
          collapsed: state.browser.devToolsCollapsed,
          size:
            devToolsPosition === "right"
              ? state.browser.devToolsPanelWidth
              : devToolsPanelHeight,
          onSizeChange:
            devToolsPosition === "right"
              ? state.browser.setDevToolsPanelWidth
              : setDevToolsPanelHeight,
          onClose: handleCloseDevTools,
          minSize: devToolsPosition === "right" ? 200 : 160,
          maxSize: devToolsPosition === "right" ? 400 : 600,
        }),
      [
        devToolsContent,
        devToolsPosition,
        state.browser.devToolsCollapsed,
        state.browser.devToolsPanelWidth,
        state.browser.setDevToolsPanelWidth,
        devToolsPanelHeight,
        handleCloseDevTools,
      ]
    );

    // ============================================
    // Phase 2.2: publish the Browser host's render surface above the tab
    // dispatcher. Mirrors `ProjectHostProvider` — the value bundles the
    // shared-webview activation flags + the DevTools polling stack + panel
    // handlers so staged browser renderers (`browser-session` / `devtools`)
    // can consume it via `useBrowserHostContext` once `UnifiedTabContent` is
    // mounted for browser tabs. Providing it here is additive — BrowserLayout
    // below still renders its bespoke `SharedBrowserWorkspace` /
    // `SharedBrowserDevToolsPanel` directly and is unchanged.
    // ============================================

    const browser = state.browser;
    const showBrowserViewport = state.showBrowserViewport;
    const automationRunning = state.automation.isRunning;

    const browserHostValue = useMemo<BrowserHostContextValue>(
      () => ({
        repoPath,
        browserState: browser.browserState,
        isWorkspaceActive:
          isActive && showBrowserViewport && !automationRunning,
        hideWebviews: !isActive || !showBrowserViewport,
        webviewBottomInsetPx: 0,
        isInspectMode: browser.isInspectMode,
        onToggleInspectMode: browser.toggleInspectMode,
        onOpenNativeDevTools: browser.handleOpenNativeDevTools,
        onToggleDevToolsPane: browser.handleToggleDevTools,
        devToolsPaneCollapsed: browser.devToolsCollapsed,
        devToolsCollapsed: browser.devToolsCollapsed,
        onToggleDevToolsCollapse: browser.handleToggleDevTools,
        devToolsPanelWidth: browser.devToolsPanelWidth,
        onDevToolsPanelWidthChange: browser.setDevToolsPanelWidth,
        devToolsPanelHeight,
        onDevToolsPanelHeightChange: setDevToolsPanelHeight,
        devToolsPosition,
        onToggleDevToolsPosition: handleToggleDevToolsPosition,
        consoleEntries: browser.entries,
        onClearConsoleEntries: browser.clearEntries,
        networkEntries: browser.networkEntries,
        onClearNetworkEntries: browser.clearNetworkEntries,
        errorCount: browser.errorCount,
        warningCount: browser.warningCount,
        selectedElement: browser.selectedElement,
        webviewLabel: browser.activeWebviewLabel,
        currentUrl: browser.currentUrl,
      }),
      [
        repoPath,
        isActive,
        showBrowserViewport,
        automationRunning,
        devToolsPanelHeight,
        devToolsPosition,
        handleToggleDevToolsPosition,
        browser.browserState,
        browser.isInspectMode,
        browser.toggleInspectMode,
        browser.handleOpenNativeDevTools,
        browser.handleToggleDevTools,
        browser.devToolsCollapsed,
        browser.devToolsPanelWidth,
        browser.setDevToolsPanelWidth,
        browser.entries,
        browser.clearEntries,
        browser.networkEntries,
        browser.clearNetworkEntries,
        browser.errorCount,
        browser.warningCount,
        browser.selectedElement,
        browser.activeWebviewLabel,
        browser.currentUrl,
      ]
    );

    // ============================================
    // Render
    // ============================================

    return (
      <BrowserHostProvider value={browserHostValue}>
        <WorkStationShell
          primarySidebarConfig={primarySidebarConfig}
          secondaryPanelConfig={secondaryPanelConfig}
          content={mainContent}
          statusBar={null}
          layoutMode={state.browser.layoutMode}
          appClassName="browser-explorer"
        />
      </BrowserHostProvider>
    );
  }
);

BrowserLayout.displayName = "BrowserLayout";

export default BrowserLayout;

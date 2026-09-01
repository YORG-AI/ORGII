import { useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import { Placeholder } from "@src/components/Placeholder";
import { TabBarTrailingIconButton } from "@src/components/TabPill/TabBarTrailingIconButton";
import { SIMULATOR_PRIMARY_SIDEBAR } from "@src/config/simulatorPrimarySidebar";
import { useBrowserAutomation } from "@src/engines/BrowserCore/hooks/useBrowserAutomation";
import EventWrapper from "@src/engines/ChatPanel/adapters/EventWrapper";
import { AppType } from "@src/engines/Simulator/types/appTypes";
import { usePublishWorkstationTabHeader } from "@src/hooks/tabHost/useWorkstationTabHeader";
import {
  Add01Icon,
  ArrowRight01Icon,
  HugeiconsIcon,
  Shield01Icon,
} from "@src/icons";
import { buildSelectedElementLabel } from "@src/modules/WorkStation/Browser/BrowserLayout/browserLayoutUtils";
import { buildDomComponentJsonFromElementInfo } from "@src/modules/WorkStation/Browser/BrowserLayout/buildDomComponentJson";
import { useBrowserSessions } from "@src/modules/WorkStation/Browser/hooks/useBrowserSessions";
import {
  NoTabsPlaceholder,
  SimulatorReplayChrome,
  WorkStationShell,
  buildPrimarySidebarConfig,
  buildSecondaryPanelConfig,
  useSimulatorAwaitingAgentCaption,
  useSimulatorPlaceholderActions,
} from "@src/modules/WorkStation/shared";
import { BrowserStatusBar } from "@src/modules/WorkStation/shared/StatusBar";
import { addToAgentAtom } from "@src/store/ui/addToAgentAtom";
import {
  simulatorEffectiveDockAppAtom,
  simulatorPrimarySidebarCollapsedAtom,
  simulatorPrimarySidebarPositionAtom,
  simulatorPrimarySidebarWidthAtom,
  simulatorPrimarySidebarWidthPersistAtom,
} from "@src/store/ui/simulatorAtom";
import {
  clearScreenshotCacheAtom,
  insertScreenshotCacheAtom,
  screenshotCacheAtom,
} from "@src/store/workstation/browser/browserAutomationAtom";
import type { BackendEvent } from "@src/types/session/steps";

import BrowserPrimarySidebar from "../Panels/BrowserPrimarySidebar";
import {
  SHARED_BROWSER_HOST,
  SHARED_BROWSER_HOST_SCOPE,
  SharedBrowserDevToolsPanel,
  SharedBrowserWorkspace,
} from "../shared";
import BrowserSidebar from "./BrowserSidebar";
import {
  TAB_ID_BY_ENTRY_CATEGORY,
  getEntryCategory,
} from "./browserReplayUtils";
import type { BrowserEntry } from "./types";
import { useBrowser } from "./useBrowser";
import { useBrowserReplayDisplay } from "./useBrowserReplayDisplay";
import { useBrowserReplayTabs } from "./useBrowserReplayTabs";
import { useReplayScreenshotResolution } from "./useReplayScreenshotResolution";
import { hasScreenshotMarker, inferImageMime } from "./utils/browserEventUtils";

interface SessionReplayBrowserProps {
  currentEvent?: unknown;
  mode?: "interactive" | "simulation";
  isActive?: boolean;
}

const SessionReplayBrowserComponent: React.FC<SessionReplayBrowserProps> = ({
  currentEvent,
  mode = "simulation",
  isActive = true,
}) => {
  const { t } = useTranslation("sessions");
  const { t: tCommon } = useTranslation("common");
  const activeDockAppForReplay = useAtomValue(simulatorEffectiveDockAppAtom);
  const isBrowserReplayActive =
    isActive &&
    (activeDockAppForReplay === null ||
      activeDockAppForReplay === AppType.BROWSER);
  const myTabsBrowser = useBrowserSessions({ enabled: isBrowserReplayActive });
  const myTabsBrowserState = myTabsBrowser.browserState;
  const setMyTabsDevToolsCollapsed = myTabsBrowser.setDevToolsCollapsed;
  const setMyTabsDevToolsPosition = myTabsBrowser.setDevToolsPosition;
  const primarySidebarCollapsed = useAtomValue(
    simulatorPrimarySidebarCollapsedAtom
  );
  const primarySidebarPosition = useAtomValue(
    simulatorPrimarySidebarPositionAtom
  );
  const primarySidebarWidth = useAtomValue(simulatorPrimarySidebarWidthAtom);
  const setPrimarySidebarWidthPersist = useSetAtom(
    simulatorPrimarySidebarWidthPersistAtom
  );
  const setAddToAgent = useSetAtom(addToAgentAtom);
  const automation = useBrowserAutomation({ enabled: isBrowserReplayActive });
  const isAutomationActive = automation.isRunning;
  const cache = useAtomValue(screenshotCacheAtom);
  const insertCache = useSetAtom(insertScreenshotCacheAtom);
  const clearScreenshotCache = useSetAtom(clearScreenshotCacheAtom);

  const {
    browserEntries,
    selectEntry,
    activeEntry,
    internalBrowserEntries,
    activeInternalEntry,
    activeSubtool,
    isMaskShown,
  } = useBrowser();
  const simulatorPlaceholderActions = useSimulatorPlaceholderActions(mode);
  const simulatorAwaitingAgentCaption = useSimulatorAwaitingAgentCaption();

  const [devToolsPanelHeight, setDevToolsPanelHeight] = useState(240);

  const handlePrimarySidebarWidthChange = useCallback(
    (width: number) => {
      setPrimarySidebarWidthPersist(width);
    },
    [setPrimarySidebarWidthPersist]
  );

  const handleCloseDevTools = useCallback(() => {
    setMyTabsDevToolsCollapsed(true);
  }, [setMyTabsDevToolsCollapsed]);

  const handleToggleDevToolsPosition = useCallback(() => {
    setMyTabsDevToolsPosition("toggle");
  }, [setMyTabsDevToolsPosition]);

  useReplayScreenshotResolution({
    activeEntry,
    cache,
    insertCache,
    clearScreenshotCache,
    isBrowserReplayActive,
  });

  // Also handle screenshot marker fallback for live automation screenshot
  useEffect(() => {
    if (!activeEntry || !("event" in activeEntry)) return;
    const entry = activeEntry as BrowserEntry;
    if (!hasScreenshotMarker(entry.event)) return;
  }, [activeEntry]);

  const {
    displayData,
    headerInfo,
    nativeHeaderInfo,
    nativeDisplayContent,
    activeEntryId,
  } = useBrowserReplayDisplay({
    activeEntry,
    activeInternalEntry,
    activeSubtool,
    isAutomationActive,
    automation,
    cache,
  });

  const {
    visibleActiveTabId,
    activeBrowserCategory,
    showMyTabsBrowser,
    showAgentBrowserCategory,
    browserTabs,
    handleBrowserTabClick,
    handleNewMyTabsSession,
    handleNewPrivateMyTabsSession,
    handleSelectMyTabsSession,
    handleCloseMyTabsSession,
    handleOpenMyTabsHistoryUrl,
  } = useBrowserReplayTabs({
    browserEntries,
    internalBrowserEntries,
    activeEntry,
    activeInternalEntry,
    activeSubtool,
    myTabsBrowserState,
  });

  const showActiveMyTabsBrowser = showMyTabsBrowser && isBrowserReplayActive;
  const showActiveBrowserCategory =
    showAgentBrowserCategory && isBrowserReplayActive;

  const displayScreenshot = displayData?.screenshot ?? null;
  const isCurrentEventLoading = activeEntry !== null && !displayData;
  const displayScreenshotSrc = useMemo(() => {
    if (!displayScreenshot) return null;
    return `data:${inferImageMime(displayScreenshot)};base64,${displayScreenshot}`;
  }, [displayScreenshot]);

  const agentBrowserHeaderContent = useMemo(() => {
    const activeHeaderInfo =
      activeSubtool === "internal_browser" ? nativeHeaderInfo : headerInfo;

    if (!activeHeaderInfo) return null;

    return (
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {activeHeaderInfo.categoryIcon}
        <span className="shrink-0 text-[13px] text-text-2">
          {activeHeaderInfo.categoryLabel}
        </span>
        {activeHeaderInfo.detailText && (
          <>
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              data-icon="chevron-right"
              size={12}
              className="shrink-0 text-text-4"
            />
            {activeHeaderInfo.detailIcon}
            <span className="min-w-0 truncate text-[13px] font-medium text-text-1">
              {activeHeaderInfo.detailText}
            </span>
          </>
        )}
        {activeSubtool === "internal_browser" && isMaskShown && (
          <div className="ml-auto flex items-center gap-1">
            <HugeiconsIcon
              icon={Shield01Icon}
              data-icon="shield"
              size={14}
              className="text-warning-6"
            />
          </div>
        )}
      </div>
    );
  }, [activeSubtool, headerInfo, isMaskShown, nativeHeaderInfo]);

  usePublishWorkstationTabHeader({
    host: "simulator",
    content: agentBrowserHeaderContent,
    enabled: showActiveBrowserCategory && agentBrowserHeaderContent !== null,
  });

  const handleSelectAgentEntry = useCallback(
    (entryId: string) => {
      const category = getEntryCategory(
        entryId,
        browserEntries,
        internalBrowserEntries
      );
      const tabId = category ? TAB_ID_BY_ENTRY_CATEGORY.get(category) : null;
      if (tabId) {
        handleBrowserTabClick(tabId);
      }
      selectEntry(entryId);
    },
    [browserEntries, internalBrowserEntries, handleBrowserTabClick, selectEntry]
  );

  const primarySidebarConfig = useMemo(
    () =>
      buildPrimarySidebarConfig({
        content: (
          <div className="relative h-full w-full overflow-hidden">
            <div
              className={`absolute inset-0 ${
                showActiveMyTabsBrowser
                  ? "pointer-events-auto visible"
                  : "pointer-events-none invisible"
              }`}
            >
              <BrowserPrimarySidebar
                sessions={myTabsBrowserState.sessions}
                activeSessionId={myTabsBrowserState.activeSessionId}
                onSelectSession={handleSelectMyTabsSession}
                onNewSession={handleNewMyTabsSession}
                onNewPrivateSession={handleNewPrivateMyTabsSession}
                onCloseSession={handleCloseMyTabsSession}
                onOpenHistoryUrl={handleOpenMyTabsHistoryUrl}
              />
            </div>
            <div
              className={`absolute inset-0 ${
                showActiveBrowserCategory
                  ? "pointer-events-auto visible"
                  : "pointer-events-none invisible"
              }`}
            >
              {activeBrowserCategory && (
                <BrowserSidebar
                  category={activeBrowserCategory}
                  entries={browserEntries}
                  internalBrowserEntries={internalBrowserEntries}
                  activeEntryId={activeEntryId}
                  onSelectEntry={handleSelectAgentEntry}
                />
              )}
            </div>
          </div>
        ),
        collapsed: primarySidebarCollapsed,
        size: primarySidebarWidth,
        onSizeChange: handlePrimarySidebarWidthChange,
        minSize: SIMULATOR_PRIMARY_SIDEBAR.minWidth,
        maxSize: SIMULATOR_PRIMARY_SIDEBAR.maxWidth,
        resetSize: SIMULATOR_PRIMARY_SIDEBAR.defaultWidth,
      }),
    [
      browserEntries,
      internalBrowserEntries,
      activeEntryId,
      showActiveMyTabsBrowser,
      showActiveBrowserCategory,
      activeBrowserCategory,
      myTabsBrowserState.sessions,
      myTabsBrowserState.activeSessionId,
      handleSelectMyTabsSession,
      handleCloseMyTabsSession,
      handleNewMyTabsSession,
      handleNewPrivateMyTabsSession,
      handleOpenMyTabsHistoryUrl,
      handleSelectAgentEntry,
      primarySidebarCollapsed,
      primarySidebarWidth,
      handlePrimarySidebarWidthChange,
    ]
  );

  const devToolsPosition = myTabsBrowser.devToolsPosition;

  const devToolsContent = useMemo(
    () => (
      <SharedBrowserDevToolsPanel
        isCollapsed={myTabsBrowser.devToolsCollapsed}
        onToggleCollapse={myTabsBrowser.handleToggleDevTools}
        width={myTabsBrowser.devToolsPanelWidth}
        onWidthChange={myTabsBrowser.setDevToolsPanelWidth}
        entries={myTabsBrowser.entries}
        onClearEntries={myTabsBrowser.clearEntries}
        networkEntries={myTabsBrowser.networkEntries}
        onClearNetworkEntries={myTabsBrowser.clearNetworkEntries}
        errorCount={myTabsBrowser.errorCount}
        warningCount={myTabsBrowser.warningCount}
        selectedElement={myTabsBrowser.selectedElement}
        webviewLabel={myTabsBrowser.activeWebviewLabel}
        repoPath=""
        currentUrl={myTabsBrowser.currentUrl}
        position={devToolsPosition}
        onTogglePosition={handleToggleDevToolsPosition}
      />
    ),
    [
      myTabsBrowser.devToolsCollapsed,
      myTabsBrowser.handleToggleDevTools,
      myTabsBrowser.devToolsPanelWidth,
      myTabsBrowser.setDevToolsPanelWidth,
      myTabsBrowser.entries,
      myTabsBrowser.clearEntries,
      myTabsBrowser.networkEntries,
      myTabsBrowser.clearNetworkEntries,
      myTabsBrowser.errorCount,
      myTabsBrowser.warningCount,
      myTabsBrowser.selectedElement,
      myTabsBrowser.activeWebviewLabel,
      myTabsBrowser.currentUrl,
      devToolsPosition,
      handleToggleDevToolsPosition,
    ]
  );

  const secondaryPanelConfig = useMemo(
    () =>
      buildSecondaryPanelConfig({
        content: devToolsContent,
        position: devToolsPosition,
        collapsed: myTabsBrowser.devToolsCollapsed || !showActiveMyTabsBrowser,
        size:
          devToolsPosition === "right"
            ? myTabsBrowser.devToolsPanelWidth
            : devToolsPanelHeight,
        onSizeChange:
          devToolsPosition === "right"
            ? myTabsBrowser.setDevToolsPanelWidth
            : setDevToolsPanelHeight,
        onClose: handleCloseDevTools,
        minSize: devToolsPosition === "right" ? 200 : 160,
        maxSize: devToolsPosition === "right" ? 400 : 600,
      }),
    [
      devToolsContent,
      devToolsPosition,
      myTabsBrowser.devToolsCollapsed,
      myTabsBrowser.devToolsPanelWidth,
      myTabsBrowser.setDevToolsPanelWidth,
      devToolsPanelHeight,
      handleCloseDevTools,
      showActiveMyTabsBrowser,
    ]
  );

  const selectedElement = myTabsBrowser.selectedElement;
  const currentUrl = myTabsBrowser.currentUrl;
  const clearSelection = myTabsBrowser.clearSelection;

  const handleSendSelectedElementToChat = useCallback(() => {
    if (!selectedElement) return;

    const { jsonText, fileName } = buildDomComponentJsonFromElementInfo(
      selectedElement,
      currentUrl
    );

    setAddToAgent({
      type: "dom-component",
      fileName,
      jsonText,
    });
    clearSelection();
    Message.success(tCommon("browser.selectedElement.sentToChat"));
  }, [selectedElement, currentUrl, clearSelection, setAddToAgent, tCommon]);

  const myTabsStatusBar = useMemo(() => {
    if (!showActiveMyTabsBrowser) return null;

    return (
      <BrowserStatusBar
        url={myTabsBrowser.currentUrl}
        isLoading={myTabsBrowser.isLoading}
        errorCount={myTabsBrowser.errorCount}
        warningCount={myTabsBrowser.warningCount}
        isDevToolsOpen={!myTabsBrowser.devToolsCollapsed}
        onToggleDevTools={myTabsBrowser.handleToggleDevTools}
        isPrivate={myTabsBrowser.isPrivate}
        sessionCount={myTabsBrowser.sessionCount}
        currentSessionIndex={myTabsBrowser.currentSessionIndex}
        hasSelectedElement={myTabsBrowser.selectedElement !== null}
        selectedElementLabel={
          myTabsBrowser.selectedElement
            ? buildSelectedElementLabel(myTabsBrowser.selectedElement)
            : undefined
        }
        onSendSelectedElementToChat={handleSendSelectedElementToChat}
        onClearSelectedElement={myTabsBrowser.clearSelection}
        className="h-[48px]!"
      />
    );
  }, [
    showActiveMyTabsBrowser,
    myTabsBrowser.currentUrl,
    myTabsBrowser.isLoading,
    myTabsBrowser.errorCount,
    myTabsBrowser.warningCount,
    myTabsBrowser.devToolsCollapsed,
    myTabsBrowser.handleToggleDevTools,
    myTabsBrowser.isPrivate,
    myTabsBrowser.sessionCount,
    myTabsBrowser.currentSessionIndex,
    myTabsBrowser.selectedElement,
    handleSendSelectedElementToChat,
    myTabsBrowser.clearSelection,
  ]);

  const mainContent = (
    <div className="allow-select-deep relative min-w-0 flex-1 overflow-hidden">
      <div
        className={`absolute inset-0 ${
          showActiveMyTabsBrowser
            ? "pointer-events-auto visible"
            : "pointer-events-none invisible"
        }`}
      >
        <SharedBrowserWorkspace
          hostId={SHARED_BROWSER_HOST.AGENT_STATION}
          scope={SHARED_BROWSER_HOST_SCOPE.AGENT_STATION}
          active={showActiveMyTabsBrowser}
          browserState={myTabsBrowserState}
          onOpenNativeDevTools={myTabsBrowser.handleOpenNativeDevTools}
          onToggleDevToolsPane={myTabsBrowser.handleToggleDevTools}
          devToolsPaneCollapsed={myTabsBrowser.devToolsCollapsed}
          hideWebviews={!showActiveMyTabsBrowser}
          publishUrlBarToHost="simulator"
          isInspectMode={myTabsBrowser.isInspectMode}
          onToggleInspectMode={myTabsBrowser.toggleInspectMode}
          placeholderCaption={simulatorAwaitingAgentCaption}
          placeholderActions={simulatorPlaceholderActions}
        />
      </div>

      <div
        className={`flex h-full min-w-0 flex-col overflow-hidden ${
          showActiveBrowserCategory
            ? "pointer-events-auto visible"
            : "pointer-events-none invisible"
        }`}
      >
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {activeSubtool === "internal_browser" ? (
            nativeDisplayContent ? (
              nativeDisplayContent
            ) : isCurrentEventLoading ? (
              <Placeholder
                variant="loading"
                placement="detail-panel"
                fillParentHeight
              />
            ) : (
              <NoTabsPlaceholder
                icon="browser"
                caption={simulatorAwaitingAgentCaption}
                actions={simulatorPlaceholderActions}
              />
            )
          ) : displayData ? (
            displayScreenshotSrc ? (
              <div className="flex h-full items-center justify-center overflow-hidden">
                <img
                  src={displayScreenshotSrc}
                  alt={t("simulator.replay.browser.screenshotAlt", {
                    url: displayData.url || "",
                  })}
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            ) : (
              <div className="scrollbar-overlay h-full overflow-y-auto p-4 pb-[100px]">
                <pre className="text-[13px] leading-relaxed wrap-break-word whitespace-pre-wrap text-text-2">
                  {displayData.text}
                </pre>
              </div>
            )
          ) : isCurrentEventLoading ? (
            <Placeholder
              variant="loading"
              placement="detail-panel"
              fillParentHeight
            />
          ) : (
            <NoTabsPlaceholder
              icon="browser"
              caption={simulatorAwaitingAgentCaption}
              actions={simulatorPlaceholderActions}
            />
          )}
        </div>

        {activeSubtool === "internal_browser" && isMaskShown && (
          <div className="flex items-center gap-2 border-t border-border-1 bg-warning-1 px-3 py-1.5">
            <HugeiconsIcon
              icon={Shield01Icon}
              data-icon="shield"
              size={14}
              className="text-warning-6"
            />
            <span className="text-xs text-warning-6">
              User interaction blocked - Agent is controlling the browser
            </span>
          </div>
        )}
      </div>
    </div>
  );

  if (!isBrowserReplayActive) {
    return null;
  }

  return (
    <EventWrapper
      event={currentEvent as unknown as BackendEvent}
      mode={mode}
      expand={true}
      padding="p-0"
    >
      <SimulatorReplayChrome
        tabs={browserTabs}
        activeEventId={visibleActiveTabId}
        onTabClick={handleBrowserTabClick}
        trailingSlot={
          <TabBarTrailingIconButton
            data-action="browser.newTab"
            title={tCommon("commands.newTab")}
            shortcutId="browser_new_tab"
            onClick={handleNewMyTabsSession}
          >
            <HugeiconsIcon
              icon={Add01Icon}
              data-icon="plus"
              size={18}
              strokeWidth={2}
            />
          </TabBarTrailingIconButton>
        }
      >
        <div className="flex min-h-0 flex-1">
          <WorkStationShell
            primarySidebarConfig={primarySidebarConfig}
            secondaryPanelConfig={secondaryPanelConfig}
            content={mainContent}
            statusBar={myTabsStatusBar}
            layoutMode={primarySidebarPosition === "right" ? "right" : "left"}
            appClassName="session-replay-browser"
          />
        </div>
      </SimulatorReplayChrome>
    </EventWrapper>
  );
};

const SessionReplayBrowser = memo(SessionReplayBrowserComponent);

export default SessionReplayBrowser;

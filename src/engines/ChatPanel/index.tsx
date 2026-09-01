import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import {
  CHAT_WIDTH_CSS_VAR,
  clampChatWidth,
  getChatMaxWidth,
} from "@src/engines/ChatPanel/config";
import { ConversationParticipantsChip } from "@src/features/Org2Cloud/SessionConversation/ConversationParticipantsChip";
import SessionViewersIndicator from "@src/features/Org2Cloud/SessionViewersIndicator";
import SessionForkHeaderExtras from "@src/features/TeamCollaboration/components/SessionForkHeaderExtras";
import { useShouldOffsetChatPanelHeader } from "@src/hooks/ui/sidebar/useCollapsedSidebarChromeOffset";
import { getChatPanelBackgroundStyle } from "@src/modules/shared/layouts/viewContainerTokens";
import {
  chatPanelTabCountAtom,
  isChatPanelTabStationAvailable,
  openRuntimeInChatPanelTabAtom,
  patchChatPanelWorkItemTabAtom,
  resolveChatPanelMaximizedForLayout,
  syncActiveChatPanelTabStateAtom,
  toggleActiveChatPanelMaximizedAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import {
  type SessionContinuation,
  retargetChatPanelSessionTabAtom,
} from "@src/store/session/sessionTabPlacementAtom";
import { tuiModeAtom } from "@src/store/session/tuiModeAtom";
import { resolvedBackgroundConfigAtom } from "@src/store/ui/backgroundConfigAtom";
import {
  chatPanelContentModeAtom,
  chatPanelExploreOpenAtom,
  chatPanelMaximizedAtom,
  chatPanelSelectedCloudOrgAtom,
  chatPanelSelectedProjectAtom,
  chatPanelSelectedProjectOrgAtom,
  chatPanelSelectedWorkItemAtom,
  chatPanelSelectedWorkspaceAtom,
  chatPanelStartPageOpenAtom,
  chatWidthAtom,
} from "@src/store/ui/chatPanelAtom";
import { openSideChatAtom } from "@src/store/ui/sideChatAtom";
import { isHumanSession } from "@src/util/session/sessionDispatch";

import { useReloadSession } from "./ChatHistory/hooks/useReloadSession";
import { ChatPanelContent } from "./ChatPanelContent";
import { ChatPanelHeader } from "./ChatPanelHeader";
import { ChatPanelShell } from "./ChatPanelShell";
import {
  ChatPanelPlusMenu,
  ChatPanelTabBar,
  useChatPanelTabShortcuts,
} from "./ChatPanelTabBar";
import { NewChatHeaderActionsMenu } from "./components/NewChatHeaderActionsMenu";
// Parked with its header button below.
// import SessionContinueCliHeaderExtras from "./SessionContinueCliHeaderExtras";
import {
  SessionAlternateSurface,
  SessionHeaderViewControls,
  SessionRawToolbarActions,
} from "./components/SessionViewSwitcher";
import SessionWorkstationRail from "./components/SessionWorkstationRail";
import {
  resolveFocusedChatWorkstationRailTrackClass,
  shouldMountFocusedChatWorkstationControls,
  shouldReserveFocusedChatWorkstationPlaceholder,
} from "./focusedChatWorkstationLayout";
import { FocusedChatWorkstationMinimapPortalContext } from "./focusedChatWorkstationMinimapPortal";
import {
  resolveChatPanelChromeTopInsetPx,
  shouldCollapseChatPanelTabRow,
  shouldOverlayChatSessionHeaders,
} from "./header/chatPanelHeaderLayout";
import { useChatPanelAccessReconciliation } from "./hooks/useChatPanelAccessReconciliation";
import { useChatPanelContentState } from "./hooks/useChatPanelContentState";
import { useChatPanelCreationContent } from "./hooks/useChatPanelCreationContent";
import { useChatPanelHeaderActions } from "./hooks/useChatPanelHeaderActions";
import { useChatPanelNavigationActions } from "./hooks/useChatPanelNavigationActions";
import { useChatPanelResize } from "./hooks/useChatPanelResize";
import { useChatPanelSessionModals } from "./hooks/useChatPanelSessionModals";
import { useChatPanelTabsController } from "./hooks/useChatPanelTabsController";
import { usePanelTitle } from "./hooks/usePanelTitle";
import { useSessionViewMode } from "./hooks/useSessionViewMode";
import type { ChatPanelProps, ChatPanelRegionNotice } from "./types";

const ChatPanel: React.FC<ChatPanelProps> = memo(
  ({
    viewportWidth,
    useExternalWidth = false,
    embedded = false,
    active = true,
    position = "right",
    resizeIndicatorHost,
    sessionCreatorSlot: SessionCreatorSlot,
  }) => {
    const { t } = useTranslation([
      "sessions",
      "common",
      "projects",
      "navigation",
    ]);
    const isLeftPosition = position === "left";
    const shouldOffsetHeaderForCollapsedSidebar =
      useShouldOffsetChatPanelHeader({ position, useExternalWidth });
    const { currentSessionId, currentSession, panelTitle } = usePanelTitle();
    const activeSession = currentSession ?? undefined;
    const humanSessionActive =
      currentSession?.category === "human_session" ||
      isHumanSession(currentSessionId);
    const handleReloadSession = useReloadSession(currentSessionId ?? null);
    const sessionView = useSessionViewMode({
      sessionId: currentSessionId ?? null,
      humanSession: humanSessionActive,
    });

    const contentMode = useAtomValue(chatPanelContentModeAtom);
    const startPageOpen = useAtomValue(chatPanelStartPageOpenAtom);
    const selectedWorkItem = useAtomValue(chatPanelSelectedWorkItemAtom);
    const selectedProject = useAtomValue(chatPanelSelectedProjectAtom);
    const selectedProjectOrg = useAtomValue(chatPanelSelectedProjectOrgAtom);
    const selectedWorkspace = useAtomValue(chatPanelSelectedWorkspaceAtom);
    const selectedCloudOrg = useAtomValue(chatPanelSelectedCloudOrgAtom);
    const exploreOpen = useAtomValue(chatPanelExploreOpenAtom);
    const patchWorkItemTab = useSetAtom(patchChatPanelWorkItemTabAtom);

    // Work-item edits flow through `chatPanelSelectedWorkItemAtom`; mirror them
    // back onto the owning work-item tab so re-activating the tab does not
    // replay a stale payload. No-ops when the payload reference is unchanged
    // (e.g. the seed written on tab activation).
    useEffect(() => {
      if (selectedWorkItem) patchWorkItemTab(selectedWorkItem);
    }, [selectedWorkItem, patchWorkItemTab]);

    const userChatPanelMaximized = useAtomValue(chatPanelMaximizedAtom);
    const syncActiveTabState = useSetAtom(syncActiveChatPanelTabStateAtom);
    const toggleChatFocus = useSetAtom(toggleActiveChatPanelMaximizedAtom);
    const rawChatWidth = useAtomValue(chatWidthAtom);
    const chatMaxWidth = getChatMaxWidth(viewportWidth);
    const backgroundConfig = useAtomValue(resolvedBackgroundConfigAtom);
    const chatPanelOpacityStyle = React.useMemo(
      () => getChatPanelBackgroundStyle(backgroundConfig.pageOpacity),
      [backgroundConfig.pageOpacity]
    );
    const chatWidth = clampChatWidth(rawChatWidth, viewportWidth);

    useChatPanelAccessReconciliation(selectedCloudOrg);

    const chatWidthStyleValue =
      chatWidth > 0 ? `var(${CHAT_WIDTH_CSS_VAR})` : chatWidth;
    const { isDragging, panelRef, handleMouseDown } = useChatPanelResize({
      useExternalWidth,
      position,
    });

    const handleChatFocusToggle = useCallback(() => {
      toggleChatFocus(viewportWidth);
    }, [toggleChatFocus, viewportWidth]);

    const isCliAgentSession = currentSession?.category === "cli_agent";
    const [tuiMode, setTuiMode] = useAtom(tuiModeAtom(currentSessionId ?? ""));
    const showTuiModeToggle = Boolean(currentSessionId) && isCliAgentSession;
    const handleTuiModeToggle = useCallback(() => {
      setTuiMode((prev) => !prev);
    }, [setTuiMode]);

    const [regionNotice, setRegionNotice] =
      React.useState<ChatPanelRegionNotice | null>(null);
    const handleRegionNoticeChange = useCallback(
      (notice: ChatPanelRegionNotice | null) => {
        setRegionNotice(notice);
      },
      []
    );

    const { openProjectCreate, openWorkItemCreate, showSessionSurface } =
      useChatPanelNavigationActions();

    const {
      activeTab,
      handleNewSessionTab,
      handleNewTerminalTab,
      handleOpenCliTerminal,
      handleOpenLaunchpadTab,
      handleOpenKanbanTab,
      isTerminalTabActive,
      terminalTabs,
    } = useChatPanelTabsController({
      newSessionTitle: t("sessions:chat.startPage.newSession.title"),
      kanbanTitle: t("sessions:simulator.tabs.kanban"),
      showSessionSurface,
    });
    const tabCount = useAtomValue(chatPanelTabCountAtom);
    const isStandaloneToolTabActive =
      activeTab?.type === "work-management" || activeTab?.type === "runtime";
    const stationAvailable = isChatPanelTabStationAvailable(
      activeTab,
      viewportWidth
    );
    const isChatFocus = resolveChatPanelMaximizedForLayout(
      userChatPanelMaximized,
      activeTab,
      viewportWidth
    );
    const [focusedWorkstationMenuHost, setFocusedWorkstationMenuHost] =
      useState<HTMLSpanElement | null>(null);
    const focusedWorkstationMenuHostRef = useCallback(
      (node: HTMLSpanElement | null) => {
        setFocusedWorkstationMenuHost(node);
      },
      []
    );
    const [focusedWorkstationMinimapHost, setFocusedWorkstationMinimapHost] =
      useState<HTMLDivElement | null>(null);
    const focusedWorkstationMinimapHostRef = useCallback(
      (node: HTMLDivElement | null) => {
        setFocusedWorkstationMinimapHost(node);
      },
      []
    );
    const retargetChatPanelSession = useSetAtom(
      retargetChatPanelSessionTabAtom
    );
    const handleSessionContinuation = useCallback(
      (continuation: SessionContinuation) => {
        if (activeTab?.type !== "session" || !activeTab.sessionId) return;
        retargetChatPanelSession({
          ...continuation,
          sourceSessionId: activeTab.sessionId,
          tabId: activeTab.id,
        });
      },
      [activeTab, retargetChatPanelSession]
    );

    // Tab shortcuts (⌘W/⌘]/⌘[/⌘N + "create-chat-tab") stay mounted here so
    // they keep working while the visual tab strip is hidden off the start page.
    useChatPanelTabShortcuts({
      onNewSession: handleNewSessionTab,
      onNewTerminal: handleNewTerminalTab,
      containerRef: panelRef,
    });

    React.useLayoutEffect(() => {
      syncActiveTabState();
    }, [activeTab, syncActiveTabState]);

    const {
      closeHeaderActionsMenu,
      copyEventJsonLabel,
      displayMode,
      eventCount,
      handleCompactDisplayModeToggle,
      handleCopyEventJson,
      handleOpenSearch,
      handlePaginationToggle,
      handleReloadFromMenu,
      handleTokenUsageVisibleToggle,
      handleTurnMetadataVisibleToggle,
      headerActionsDropdownRef,
      headerActionsPosition,
      headerActionsTriggerRef,
      isHeaderActionsOpen,
      isHeaderActionsPositioned,
      paginationEnabled,
      tokenUsageVisible,
      turnMetadataVisible,
      toggleHeaderActionsMenu,
    } = useChatPanelHeaderActions({
      sessionId: currentSessionId ?? null,
      handleReloadSession,
    });

    const openSideChat = useSetAtom(openSideChatAtom);
    const handleOpenSideChat = useCallback(() => {
      // Creator mode — the side chat exists to start/watch a session
      // without leaving the active tab.
      openSideChat(null);
    }, [openSideChat]);

    const contentState = useChatPanelContentState({
      active,
      contentMode,
      currentSessionId: currentSessionId ?? null,
      exploreOpen,
      selectedCloudOrg,
      selectedProject,
      selectedProjectOrg,
      selectedWorkItem,
      selectedWorkspace,
    });
    const showFocusedWorkstationControls =
      shouldMountFocusedChatWorkstationControls({
        activeTabType: activeTab?.type ?? null,
        isChatFocus,
        showSessionContent: contentState.showSessionContent,
      });
    const reserveFocusedWorkstationPlaceholder =
      shouldReserveFocusedChatWorkstationPlaceholder({
        activeTabType: activeTab?.type ?? null,
        isChatFocus,
        startPageOpen,
      });

    const {
      handleMoveToWorkstation,
      handleOpenExportSessionJson,
      handleOpenLinkWorkItem,
      handleOpenCloudShareSettings,
      showCloudShareSettings,
      sessionModals,
    } = useChatPanelSessionModals({
      activeChatTab: activeTab,
      activeSession,
      closeHeaderActionsMenu,
      currentSession: currentSession ?? null,
      currentSessionId: currentSessionId ?? null,
      t,
    });

    const showResizeHandle = !useExternalWidth;
    const borderClasses =
      embedded && !showResizeHandle
        ? isLeftPosition
          ? "border-r border-border-1"
          : "border-l border-border-1"
        : "";
    const useFullScreenCreator =
      isChatFocus || useExternalWidth || chatWidth >= chatMaxWidth;
    const creatorVariant = useFullScreenCreator ? "fullScreen" : "default";
    const openRuntimeTab = useSetAtom(openRuntimeInChatPanelTabAtom);
    const handleShowRuntime = useCallback(() => {
      openRuntimeTab(t("sessions:chat.startPage.tabs.runtime"));
    }, [openRuntimeTab, t]);
    const emptyChatContent = useChatPanelCreationContent({
      t,
      startPageOpen,
      sessionCreatorSlot: SessionCreatorSlot,
      creatorVariant,
      handleShowRuntime,
      handleOpenLaunchpadTab,
      handleOpenCliTerminal,
      handleRegionNoticeChange,
    });
    const tabStrip = <ChatPanelTabBar />;

    const tabStripPlus = (
      <>
        <ChatPanelPlusMenu
          onOpenLaunchpad={handleOpenLaunchpadTab}
          onOpenKanban={handleOpenKanbanTab}
          onOpenRuntime={handleShowRuntime}
          onNewProject={openProjectCreate}
          onNewWorkItem={openWorkItemCreate}
          onOpenSideChat={handleOpenSideChat}
        />
        {startPageOpen && !isStandaloneToolTabActive && (
          <NewChatHeaderActionsMenu />
        )}
      </>
    );

    const overlayChatHeaders = shouldOverlayChatSessionHeaders({
      showSessionContent: contentState.showSessionContent,
      standaloneToolTabActive: isStandaloneToolTabActive,
      humanSessionActive,
    });
    const tabRowCollapsed = shouldCollapseChatPanelTabRow({
      tabCount,
    });
    const chromeTopInsetPx = resolveChatPanelChromeTopInsetPx(
      overlayChatHeaders,
      tabRowCollapsed
    );

    const headerSection = (
      <ChatPanelHeader
        activeSessionExists={Boolean(activeSession)}
        chatPanelPosition={position}
        copyEventJsonLabel={copyEventJsonLabel}
        currentSessionId={currentSessionId ?? null}
        displayMode={displayMode}
        eventsLength={eventCount}
        handleChatFocusToggle={handleChatFocusToggle}
        handleCompactDisplayModeToggle={handleCompactDisplayModeToggle}
        handleCopyEventJson={handleCopyEventJson}
        handleOpenExportSessionJson={handleOpenExportSessionJson}
        handleOpenLinkWorkItem={handleOpenLinkWorkItem}
        handleOpenCloudShareSettings={handleOpenCloudShareSettings}
        handleMoveToWorkstation={handleMoveToWorkstation}
        handleOpenSearch={handleOpenSearch}
        handlePaginationToggle={handlePaginationToggle}
        handleReloadFromMenu={handleReloadFromMenu}
        handleTokenUsageVisibleToggle={handleTokenUsageVisibleToggle}
        handleTurnMetadataVisibleToggle={handleTurnMetadataVisibleToggle}
        headerActionsDropdownRef={headerActionsDropdownRef}
        headerActionsPosition={headerActionsPosition}
        headerActionsTriggerRef={headerActionsTriggerRef}
        isChatFocus={isChatFocus}
        isHeaderActionsOpen={isHeaderActionsOpen}
        isHeaderActionsPositioned={isHeaderActionsPositioned}
        focusedWorkstationMenuHostRef={
          showFocusedWorkstationControls
            ? focusedWorkstationMenuHostRef
            : undefined
        }
        paginationEnabled={paginationEnabled}
        tokenUsageVisible={tokenUsageVisible}
        turnMetadataVisible={turnMetadataVisible}
        shouldOffsetHeaderForCollapsedSidebar={
          shouldOffsetHeaderForCollapsedSidebar
        }
        stationAvailable={stationAvailable}
        showHeader={contentState.showHeader || isStandaloneToolTabActive}
        showSessionContent={
          contentState.showSessionContent && !isStandaloneToolTabActive
        }
        showCloudShareSettings={showCloudShareSettings}
        showTranscriptActions={!humanSessionActive}
        showTuiModeToggle={showTuiModeToggle}
        tuiMode={tuiMode}
        handleTuiModeToggle={handleTuiModeToggle}
        tabStrip={tabStrip}
        tabStripPlus={tabStripPlus}
        tabRowCollapsed={tabRowCollapsed}
        sessionHeaderExtras={
          <>
            <SessionViewersIndicator sessionId={currentSessionId ?? null} />
            <ConversationParticipantsChip
              sessionId={currentSessionId ?? null}
            />
            {/* "Continue in <agent>" is parked: it hands the session to a
                CLI in a Workstation terminal tab, which leaves the focused
                chat — the same reason the trail's Workstation-navigating
                rows were parked. */}
            {/* <SessionContinueCliHeaderExtras
              session={currentSession ?? null}
              sessionId={currentSessionId ?? null}
              onOpenCliTerminal={handleOpenCliTerminal}
            /> */}
            <SessionForkHeaderExtras session={currentSession ?? null} />
            <SessionRawToolbarActions
              view={sessionView}
              testIdPrefix="chat-panel-session"
            />
          </>
        }
        sessionHeaderContent={
          contentState.showSessionContent &&
          !isStandaloneToolTabActive &&
          currentSessionId ? (
            <SessionHeaderViewControls
              session={currentSession}
              sessionId={currentSessionId}
              fallbackName={panelTitle}
              onParentSessionClick={handleSessionContinuation}
              view={sessionView}
              testIdPrefix="chat-panel-session"
            />
          ) : null
        }
        overlayPublishedHeader={overlayChatHeaders}
        t={t}
        toggleHeaderActionsMenu={toggleHeaderActionsMenu}
        visibleRegionNotice={regionNotice}
      />
    );

    const chatColumn = (
      <ChatPanelContent
        currentSessionId={currentSessionId ?? null}
        displayMode={displayMode}
        emptyChatContent={emptyChatContent}
        onSessionContinuation={handleSessionContinuation}
        paginationEnabled={paginationEnabled}
        position={position}
        showPanelContent={contentState.showPanelContent}
        showSessionContent={contentState.showSessionContent}
        sessionViewMode={sessionView.mode}
        chromeTopInset={chromeTopInsetPx}
        alternateSessionView={
          <SessionAlternateSurface
            sessionId={currentSessionId ?? null}
            view={sessionView}
            topInset={chromeTopInsetPx}
          />
        }
      />
    );

    return (
      <FocusedChatWorkstationMinimapPortalContext.Provider
        value={
          showFocusedWorkstationControls ? focusedWorkstationMinimapHost : null
        }
      >
        <ChatPanelShell
          activeTab={activeTab}
          borderClasses={borderClasses}
          chatColumn={chatColumn}
          chatPanelOpacityStyle={chatPanelOpacityStyle}
          chatWidth={chatWidth}
          chatWidthStyleValue={chatWidthStyleValue}
          embedded={embedded}
          focusedWorkstationRail={
            showFocusedWorkstationControls ? (
              <SessionWorkstationRail
                compactMenuHost={focusedWorkstationMenuHost}
                conversationMinimapHostRef={focusedWorkstationMinimapHostRef}
                session={currentSession}
                sessionId={currentSessionId}
                topInset={chromeTopInsetPx}
              />
            ) : reserveFocusedWorkstationPlaceholder ? (
              <div
                aria-hidden
                data-testid="launchpad-workstation-rail-placeholder"
                data-workstation-trail-track
                className={`h-full shrink-0 ${resolveFocusedChatWorkstationRailTrackClass(true)}`}
              />
            ) : null
          }
          headerSection={headerSection}
          isDragging={isDragging}
          isLeftPosition={isLeftPosition}
          isTerminalTabActive={isTerminalTabActive}
          onResizeMouseDown={handleMouseDown}
          panelRef={panelRef}
          resizeIndicatorHost={resizeIndicatorHost}
          resizeTooltipLabel={t("chat.hideWorkstation")}
          resizeTooltipShortcut={getShortcutKeys("maximize_chat")}
          sessionModals={sessionModals}
          showResizeHandle={showResizeHandle}
          terminalTabs={terminalTabs}
          useExternalWidth={useExternalWidth}
        />
      </FocusedChatWorkstationMinimapPortalContext.Provider>
    );
  }
);

ChatPanel.displayName = "ChatPanel";

export default ChatPanel;

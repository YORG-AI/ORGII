import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import {
  WIZARD_IDS,
  buildIntegrationsPath,
  buildWizardPath,
} from "@src/config/mainAppPaths";
import { useRouteViewMode } from "@src/config/routeViewModeConfig";
import {
  CHAT_WIDTH_CSS_VAR,
  clampChatWidth,
  getChatMaxWidth,
} from "@src/engines/ChatPanel/config";
import SessionCommentsHeaderExtras from "@src/features/Org2Cloud/SessionComments/SessionCommentsHeaderExtras";
import {
  org2CloudOrgsAtom,
  org2CloudOrgsLoadedAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import type { CreatedOrgResult } from "@src/features/TeamCollaboration/components/CreateCollabOrgView";
import SessionForkHeaderExtras from "@src/features/TeamCollaboration/components/SessionForkHeaderExtras";
import { useShouldOffsetChatPanelHeader } from "@src/hooks/ui/sidebar/useCollapsedSidebarChromeOffset";
import { allAgentDefsAtom } from "@src/modules/MainApp/AgentOrgs/store/builtInAgentsAtom";
import { getChatPanelBackgroundStyle } from "@src/modules/shared/layouts/viewContainerTokens";
import { installAvailableAppUpdate } from "@src/scaffold/AppUpdater";
import {
  closeCloudOrgManagementChatPanelTabAtom,
  openRuntimeInChatPanelTabAtom,
  openSessionInNewChatTabAtom,
  patchChatPanelWorkItemTabAtom,
  syncActiveChatPanelTabStateAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { projectListRefreshAtom } from "@src/store/project/projectAtom";
import { sessionCreatorStateAtom } from "@src/store/session";
import {
  type SessionContinuation,
  retargetChatPanelSessionTabAtom,
} from "@src/store/session/sessionTabPlacementAtom";
import { tuiModeAtom } from "@src/store/session/tuiModeAtom";
import { resolvedBackgroundConfigAtom } from "@src/store/ui/backgroundConfigAtom";
import {
  CHAT_PANEL_CREATE_TARGET,
  chatPanelContentModeAtom,
  chatPanelCreateProjectContextAtom,
  chatPanelCreateTargetAtom,
  chatPanelExploreOpenAtom,
  chatPanelMaximizedAtom,
  chatPanelSelectedCloudOrgAtom,
  chatPanelSelectedProjectAtom,
  chatPanelSelectedProjectOrgAtom,
  chatPanelSelectedWorkItemAtom,
  chatPanelSelectedWorkspaceAtom,
  chatPanelStartPageOpenAtom,
  chatWidthAtom,
  toggleChatPanelMaximizedAtom,
} from "@src/store/ui/chatPanelAtom";
import type { WorkItemDraft } from "@src/store/workstation/projectManager";

import { useReloadSession } from "./ChatHistory/hooks/useReloadSession";
import { ChatPanelContent } from "./ChatPanelContent";
import { ChatPanelEmptyContent } from "./ChatPanelEmptyContent";
import { ChatPanelHeader } from "./ChatPanelHeader";
import { ChatPanelShell } from "./ChatPanelShell";
import {
  ChatPanelPlusMenu,
  ChatPanelTabBar,
  useChatPanelTabShortcuts,
} from "./ChatPanelTabBar";
import SessionHeaderBreadcrumb from "./components/SessionHeaderBreadcrumb";
import { useAiWorkItemCreator } from "./hooks/useAiWorkItemCreator";
import { useChatPanelContentState } from "./hooks/useChatPanelContentState";
import { useChatPanelCreateTarget } from "./hooks/useChatPanelCreateTarget";
import { useChatPanelHeaderActions } from "./hooks/useChatPanelHeaderActions";
import { useChatPanelNavigationActions } from "./hooks/useChatPanelNavigationActions";
import { useChatPanelResize } from "./hooks/useChatPanelResize";
import { useChatPanelSessionModals } from "./hooks/useChatPanelSessionModals";
import { useChatPanelTabsController } from "./hooks/useChatPanelTabsController";
import { usePanelTitle } from "./hooks/usePanelTitle";
import { useProjectWorkItemHandlers } from "./hooks/useProjectWorkItemHandlers";
import { useViewportWidth } from "./hooks/useViewportWidth";
import type { ChatPanelProps, ChatPanelRegionNotice } from "./types";

const ChatPanel: React.FC<ChatPanelProps> = memo(
  ({
    useExternalWidth = false,
    embedded = false,
    active = true,
    position = "right",
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
    const navigate = useNavigate();
    const viewMode = useRouteViewMode();
    const { currentSessionId, currentSession, panelTitle } = usePanelTitle();
    const activeSession = currentSession ?? undefined;
    const handleReloadSession = useReloadSession(currentSessionId ?? null);

    const [contentMode, setContentMode] = useAtom(chatPanelContentModeAtom);
    const [createTarget, setCreateTarget] = useAtom(chatPanelCreateTargetAtom);
    const startPageOpen = useAtomValue(chatPanelStartPageOpenAtom);
    const [workItemCreateDraft, setWorkItemCreateDraft] =
      useState<WorkItemDraft | null>(null);
    const [showWorkItemAgentCreator, setShowWorkItemAgentCreator] = useState(
      Boolean(SessionCreatorSlot)
    );
    const [showProjectAgentCreator, setShowProjectAgentCreator] = useState(
      Boolean(SessionCreatorSlot)
    );

    const selectedWorkItem = useAtomValue(chatPanelSelectedWorkItemAtom);
    const selectedProject = useAtomValue(chatPanelSelectedProjectAtom);
    const selectedProjectOrg = useAtomValue(chatPanelSelectedProjectOrgAtom);
    const selectedWorkspace = useAtomValue(chatPanelSelectedWorkspaceAtom);
    const selectedCloudOrg = useAtomValue(chatPanelSelectedCloudOrgAtom);
    const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
    const cloudOrgsLoaded = useAtomValue(org2CloudOrgsLoadedAtom);
    const closeCloudOrgManagementTab = useSetAtom(
      closeCloudOrgManagementChatPanelTabAtom
    );
    const exploreOpen = useAtomValue(chatPanelExploreOpenAtom);
    const createProjectContext = useAtomValue(
      chatPanelCreateProjectContextAtom
    );
    const patchWorkItemTab = useSetAtom(patchChatPanelWorkItemTabAtom);
    const openRuntimeTab = useSetAtom(openRuntimeInChatPanelTabAtom);

    // Work-item edits flow through `chatPanelSelectedWorkItemAtom`; mirror them
    // back onto the owning work-item tab so re-activating the tab does not
    // replay a stale payload. No-ops when the payload reference is unchanged
    // (e.g. the seed written on tab activation).
    useEffect(() => {
      if (selectedWorkItem) patchWorkItemTab(selectedWorkItem);
    }, [selectedWorkItem, patchWorkItemTab]);

    const isChatFocus = useAtomValue(chatPanelMaximizedAtom);
    const syncActiveTabState = useSetAtom(syncActiveChatPanelTabStateAtom);
    const toggleChatFocus = useSetAtom(toggleChatPanelMaximizedAtom);
    const showChatFocusToggle = viewMode === "workStation";
    const rawChatWidth = useAtomValue(chatWidthAtom);
    const viewportWidth = useViewportWidth();
    const chatMaxWidth = getChatMaxWidth(viewportWidth);
    const backgroundConfig = useAtomValue(resolvedBackgroundConfigAtom);
    const chatPanelOpacityStyle = React.useMemo(
      () => getChatPanelBackgroundStyle(backgroundConfig.pageOpacity),
      [backgroundConfig.pageOpacity]
    );
    const chatWidth = clampChatWidth(rawChatWidth, viewportWidth);

    // A teammate can lose the selected cloud org while its management panel
    // is open (member removal or org deletion). Once the authoritative roster
    // has loaded, an absent org is not a recoverable panel state: close the
    // stale surface immediately instead of leaving deleted names/actions on
    // screen. Keep the selection during the initial unknown-roster phase so
    // a cold start does not flicker the panel closed before list_my_orgs lands.
    useEffect(() => {
      if (
        selectedCloudOrg &&
        cloudOrgsLoaded &&
        !cloudOrgs.some((org) => org.orgId === selectedCloudOrg.orgId)
      ) {
        closeCloudOrgManagementTab();
      }
    }, [
      closeCloudOrgManagementTab,
      cloudOrgs,
      cloudOrgsLoaded,
      selectedCloudOrg,
    ]);
    const chatWidthStyleValue =
      chatWidth > 0 ? `var(${CHAT_WIDTH_CSS_VAR})` : chatWidth;
    const { isDragging, panelRef, handleMouseDown } = useChatPanelResize({
      useExternalWidth,
      position,
    });

    const handleChatFocusToggle = useCallback(() => {
      toggleChatFocus();
    }, [toggleChatFocus]);

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

    const {
      dispatchClearSession,
      openWorkItemCreate,
      resetActiveSession,
      setActiveSessionId,
      setWorkstationActiveSessionId,
      showSessionSurface,
    } = useChatPanelNavigationActions();

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
      launchpadTitle: t("navigation:routes.launchpad"),
      kanbanTitle: t("sessions:simulator.tabs.kanban"),
      showSessionSurface,
    });
    const isStandaloneToolTabActive =
      activeTab?.type === "work-management" || activeTab?.type === "runtime";
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

    const creatorState = useAtomValue(sessionCreatorStateAtom);
    const setCreatorState = useSetAtom(sessionCreatorStateAtom);
    const bumpProjectListRefresh = useSetAtom(projectListRefreshAtom);
    const allAgentDefs = useAtomValue(allAgentDefsAtom);

    const {
      closeHeaderActionsMenu,
      copyEventJsonLabel,
      displayMode,
      eventCount,
      handleCompactDisplayModeToggle,
      handleCopyEventJson,
      handleOpenSearch,
      handlePaginationToggle,
      handleRegisterSearchOpen,
      handleReloadFromMenu,
      handleTokenUsageVisibleToggle,
      headerActionsDropdownRef,
      headerActionsPosition,
      headerActionsTriggerRef,
      isHeaderActionsOpen,
      isHeaderActionsPositioned,
      paginationEnabled,
      tokenUsageVisible,
      toggleHeaderActionsMenu,
    } = useChatPanelHeaderActions({ handleReloadSession });

    const handleReturnToSessionCreator = useCallback(() => {
      handleOpenLaunchpadTab();
      setCreateTarget(CHAT_PANEL_CREATE_TARGET.AGENT_SESSION);
      resetActiveSession();
    }, [handleOpenLaunchpadTab, resetActiveSession, setCreateTarget]);
    const handleStartPageNewWorkItem = openWorkItemCreate;
    const openLaunchedSessionTab = useSetAtom(openSessionInNewChatTabAtom);
    const handleStartPageSessionStart = useCallback(
      (info: { sessionId: string }) => {
        openLaunchedSessionTab({ sessionId: info.sessionId });
      },
      [openLaunchedSessionTab]
    );

    const handleChatPanelCollabOrgCreated = useCallback(
      (_result: CreatedOrgResult) => {
        bumpProjectListRefresh((previous) => previous + 1);
        handleReturnToSessionCreator();
      },
      [bumpProjectListRefresh, handleReturnToSessionCreator]
    );

    const handleStartPageAddApiKey = useCallback(() => {
      const accountsPath = `${buildIntegrationsPath({ category: "models" })}?modelsTab=my-accounts`;
      navigate(buildWizardPath(accountsPath, WIZARD_IDS.KEY_ADD));
    }, [navigate]);

    const handleStartPageInstallLatestUpdate = useCallback(() => {
      void installAvailableAppUpdate();
    }, []);

    const { createTargetOptions, handleCreateTargetChange } =
      useChatPanelCreateTarget({
        allAgentDefs,
        sessionCreatorAvailable: Boolean(SessionCreatorSlot),
        setCreateTarget,
        setCreatorState,
        setShowProjectAgentCreator,
        setShowWorkItemAgentCreator,
        setWorkItemCreateDraft,
        t,
      });

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
      viewMode,
    });

    const setSelectedProject = useSetAtom(chatPanelSelectedProjectAtom);
    const setSelectedWorkItem = useSetAtom(chatPanelSelectedWorkItemAtom);
    const {
      handleCancelCollabOrgCreate,
      handleCancelProjectCreate,
      handleCancelWorkItemCreate,
      handleChatPanelProjectCreated,
      handleChatPanelWorkItemCreated,
      handleWorkItemAgentCreatorToggle,
    } = useProjectWorkItemHandlers({
      bumpProjectListRefresh,
      createProjectContext,
      dispatchClearSession,
      handleReturnToSessionCreator,
      sessionCreatorAvailable: Boolean(SessionCreatorSlot),
      setActiveSessionId,
      setContentMode,
      setCreateTarget,
      setSelectedProject,
      setSelectedWorkItem,
      setShowProjectAgentCreator,
      setShowWorkItemAgentCreator,
      setWorkItemCreateDraft,
      setWorkstationActiveSessionId,
    });
    const {
      defaultAiWorkItemAssignee,
      handleAiWorkItemSessionStart,
      resolveAiWorkItemContext,
    } = useAiWorkItemCreator({
      allAgentDefs,
      createProjectContext,
      creatorState,
      dispatchClearSession,
      setActiveSessionId,
      setContentMode,
      setCreateTarget,
      setSelectedProject,
      setSelectedWorkItem,
      setShowWorkItemAgentCreator,
      setWorkItemCreateDraft,
      setWorkstationActiveSessionId,
      sessionCreatorAvailable: Boolean(SessionCreatorSlot),
      workItemCreateDraft,
    });

    const {
      handleMoveToWorkstation,
      handleOpenExportSessionJson,
      handleOpenLinkWorkItem,
      handleOpenCloudShareSettings,
      handleOpenRawTranscript,
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
    const creatorClassName = "min-h-0 flex-1";
    const emptyChatContent = (
      <ChatPanelEmptyContent
        createProjectContext={createProjectContext}
        createTarget={createTarget}
        createTargetOptions={createTargetOptions}
        creatorClassName={creatorClassName}
        creatorVariant={creatorVariant}
        defaultAiWorkItemAssignee={defaultAiWorkItemAssignee}
        handleAiWorkItemSessionStart={handleAiWorkItemSessionStart}
        handleCancelWorkItemCreate={handleCancelWorkItemCreate}
        handleCancelCollabOrgCreate={handleCancelCollabOrgCreate}
        handleCancelProjectCreate={handleCancelProjectCreate}
        handleCreateTargetChange={handleCreateTargetChange}
        handleChatPanelProjectCreated={handleChatPanelProjectCreated}
        handleChatPanelCollabOrgCreated={handleChatPanelCollabOrgCreated}
        handleChatPanelWorkItemCreated={handleChatPanelWorkItemCreated}
        handleOpenCliTerminal={handleOpenCliTerminal}
        handleRegionNoticeChange={handleRegionNoticeChange}
        handleStartPageAddApiKey={handleStartPageAddApiKey}
        handleStartPageInstallLatestUpdate={handleStartPageInstallLatestUpdate}
        handleStartPageSessionStart={handleStartPageSessionStart}
        handleWorkItemAgentCreatorToggle={handleWorkItemAgentCreatorToggle}
        resolveAiWorkItemContext={resolveAiWorkItemContext}
        SessionCreatorSlot={SessionCreatorSlot}
        setWorkItemCreateDraft={setWorkItemCreateDraft}
        showStartPage={startPageOpen}
        showProjectAgentCreator={showProjectAgentCreator}
        showWorkItemAgentCreator={showWorkItemAgentCreator}
        t={t}
      />
    );

    const tabStrip = <ChatPanelTabBar />;

    const tabStripPlus = (
      <ChatPanelPlusMenu
        onOpenLaunchpad={handleOpenLaunchpadTab}
        onOpenKanban={handleOpenKanbanTab}
        onOpenRuntime={() =>
          openRuntimeTab(t("sessions:chat.startPage.tabs.runtime"))
        }
        onNewWorkItem={handleStartPageNewWorkItem}
      />
    );

    const headerSection = (
      <ChatPanelHeader
        activeSessionExists={Boolean(activeSession)}
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
        handleOpenRawTranscript={handleOpenRawTranscript}
        handleMoveToWorkstation={handleMoveToWorkstation}
        handleOpenSearch={handleOpenSearch}
        handlePaginationToggle={handlePaginationToggle}
        handleReloadFromMenu={handleReloadFromMenu}
        handleTokenUsageVisibleToggle={handleTokenUsageVisibleToggle}
        headerActionsDropdownRef={headerActionsDropdownRef}
        headerActionsPosition={headerActionsPosition}
        headerActionsTriggerRef={headerActionsTriggerRef}
        isChatFocus={isChatFocus}
        isHeaderActionsOpen={isHeaderActionsOpen}
        isHeaderActionsPositioned={isHeaderActionsPositioned}
        paginationEnabled={paginationEnabled}
        tokenUsageVisible={tokenUsageVisible}
        shouldOffsetHeaderForCollapsedSidebar={
          shouldOffsetHeaderForCollapsedSidebar
        }
        showChatFocusToggle={showChatFocusToggle}
        showHeader={contentState.showHeader || isStandaloneToolTabActive}
        showSessionContent={
          contentState.showSessionContent && !isStandaloneToolTabActive
        }
        showCloudShareSettings={showCloudShareSettings}
        showTuiModeToggle={showTuiModeToggle}
        tuiMode={tuiMode}
        handleTuiModeToggle={handleTuiModeToggle}
        tabStrip={tabStrip}
        tabStripPlus={tabStripPlus}
        sessionHeaderExtras={
          <>
            {/* Session-level cloud notes (Phase F) — renders null for
                  non-cloud sessions, exactly like the fork extras. */}
            <SessionCommentsHeaderExtras session={currentSession ?? null} />
            <SessionForkHeaderExtras session={currentSession ?? null} />
          </>
        }
        sessionHeaderContent={
          contentState.showSessionContent &&
          !isStandaloneToolTabActive &&
          currentSessionId ? (
            <SessionHeaderBreadcrumb
              session={currentSession}
              sessionId={currentSessionId}
              fallbackName={panelTitle}
              onParentSessionClick={handleSessionContinuation}
            />
          ) : null
        }
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
        handleRegisterSearchOpen={handleRegisterSearchOpen}
        onSessionContinuation={handleSessionContinuation}
        paginationEnabled={paginationEnabled}
        position={position}
        showBenchmarkSessionGroupContent={
          contentState.showBenchmarkSessionGroupContent
        }
        showPanelContent={contentState.showPanelContent}
        showSessionContent={contentState.showSessionContent}
      />
    );

    return (
      <ChatPanelShell
        activeTab={activeTab}
        borderClasses={borderClasses}
        chatColumn={chatColumn}
        chatPanelOpacityStyle={chatPanelOpacityStyle}
        chatWidth={chatWidth}
        chatWidthStyleValue={chatWidthStyleValue}
        embedded={embedded}
        headerSection={headerSection}
        isDragging={isDragging}
        isLeftPosition={isLeftPosition}
        isTerminalTabActive={isTerminalTabActive}
        onResizeMouseDown={handleMouseDown}
        panelRef={panelRef}
        sessionModals={sessionModals}
        showResizeHandle={showResizeHandle}
        terminalTabs={terminalTabs}
        useExternalWidth={useExternalWidth}
      />
    );
  }
);

ChatPanel.displayName = "ChatPanel";

export default ChatPanel;

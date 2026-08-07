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
  openSessionInNewChatTabAtom,
  syncActiveChatPanelTabStateAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { projectListRefreshAtom } from "@src/store/project/projectAtom";
import { sessionCreatorStateAtom } from "@src/store/session";
import { tuiModeAtom } from "@src/store/session/tuiModeAtom";
import { resolvedBackgroundConfigAtom } from "@src/store/ui/backgroundConfigAtom";
import {
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
import { sidebarCollapsedAtom } from "@src/store/ui/sidebarAtom";
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
import { ChatPanelSurfaceHeaderPublisher } from "./header";
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
    sessionSidebarWidth = 0,
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
    const { currentSessionId, panelTitle, currentSession } = usePanelTitle();
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
      resetToSessionSurface,
      setActiveSessionId,
      setStartPageOpen,
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
      currentSessionId: currentSessionId ?? null,
      launchpadTitle: t("navigation:routes.launchpad"),
      kanbanTitle: t("sessions:simulator.tabs.kanban"),
      showSessionSurface,
    });
    const isManagementTabActive = activeTab?.type === "work-management";

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
    const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);

    const {
      allBlocksCollapsed,
      closeHeaderActionsMenu,
      copyEventJsonLabel,
      displayMode,
      eventCount,
      exploreAgentSearchEnabled,
      handleCompactDisplayModeToggle,
      handleCopyEventJson,
      handleExploreAgentSearchToggle,
      handleOpenSearch,
      handlePaginationToggle,
      handleRegisterSearchOpen,
      handleReloadFromMenu,
      handleStatusBarVisibleToggle,
      handleToggleAllBlocksCollapsed,
      handleTokenUsageVisibleToggle,
      headerActionsDropdownRef,
      headerActionsPosition,
      headerActionsTriggerRef,
      isHeaderActionsOpen,
      isHeaderActionsPositioned,
      paginationEnabled,
      statusBarVisible,
      tokenUsageVisible,
      toggleHeaderActionsMenu,
    } = useChatPanelHeaderActions({ handleReloadSession });

    const collapseToggleLabel = allBlocksCollapsed
      ? t("common:actions.expandAll")
      : t("common:actions.collapseAll");

    const handleNewSession = resetToSessionSurface;
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
        showSessionSurface();
        resetActiveSession();
      },
      [bumpProjectListRefresh, resetActiveSession, showSessionSurface]
    );

    const handleStartPageAddApiKey = useCallback(() => {
      const accountsPath = `${buildIntegrationsPath({ category: "models" })}?modelsTab=my-accounts`;
      navigate(buildWizardPath(accountsPath, WIZARD_IDS.KEY_ADD));
    }, [navigate]);

    const handleStartPageInstallLatestUpdate = useCallback(() => {
      void installAvailableAppUpdate();
    }, []);

    const sessionSidebarVisible = sessionSidebarWidth > 0;
    const contentState = useChatPanelContentState({
      active,
      contentMode,
      createTarget,
      currentSessionId: currentSessionId ?? null,
      exploreOpen,
      panelTitle,
      cloudOrgHeaderTitle: selectedCloudOrg
        ? cloudOrgs.find((org) => org.orgId === selectedCloudOrg.orgId)?.name
        : undefined,
      selectedCloudOrg,
      selectedProject,
      selectedProjectOrg,
      selectedWorkItem,
      selectedWorkspace,
      sidebarCollapsed,
      sessionCreatorAvailable: Boolean(SessionCreatorSlot),
      sessionSidebarVisible,
      viewMode,
    });

    const setSelectedProject = useSetAtom(chatPanelSelectedProjectAtom);
    const setSelectedWorkItem = useSetAtom(chatPanelSelectedWorkItemAtom);
    const {
      handleCancelCollabOrgCreate,
      handleCancelWorkItemCreate,
      handleChatPanelProjectCreated,
      handleChatPanelWorkItemCreated,
      handleProjectAgentCreatorToggle,
      handleProjectTitleChange,
      handleWorkItemAgentCreatorToggle,
      handleWorkItemTitleChange,
    } = useProjectWorkItemHandlers({
      bumpProjectListRefresh,
      createProjectContext,
      dispatchClearSession,
      handleNewSession,
      selectedProject,
      selectedWorkItem,
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
      handleOpenExportSessionJson,
      handleOpenLinkWorkItem,
      handleOpenCloudShareSettings,
      showCloudShareSettings,
      handleOpenLinkProject,
      sessionModals,
    } = useChatPanelSessionModals({
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
        creatorClassName={creatorClassName}
        creatorVariant={creatorVariant}
        defaultAiWorkItemAssignee={defaultAiWorkItemAssignee}
        handleAiWorkItemSessionStart={handleAiWorkItemSessionStart}
        handleCancelWorkItemCreate={handleCancelWorkItemCreate}
        handleCancelCollabOrgCreate={handleCancelCollabOrgCreate}
        handleChatPanelProjectCreated={handleChatPanelProjectCreated}
        handleChatPanelCollabOrgCreated={handleChatPanelCollabOrgCreated}
        handleChatPanelWorkItemCreated={handleChatPanelWorkItemCreated}
        handleOpenCliTerminal={handleOpenCliTerminal}
        handleRegionNoticeChange={handleRegionNoticeChange}
        handleStartPageAddApiKey={handleStartPageAddApiKey}
        handleStartPageInstallLatestUpdate={handleStartPageInstallLatestUpdate}
        handleStartPageSessionStart={handleStartPageSessionStart}
        handleStartPageNewWorkItem={handleStartPageNewWorkItem}
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

    const publishSurfaceHeader =
      !isManagementTabActive &&
      (startPageOpen ||
        contentState.showBenchmarkSessionGroupContent ||
        contentState.showExploreContent ||
        contentState.showCloudOrgContent ||
        contentState.showWorkspaceOverviewContent);

    const tabStrip = <ChatPanelTabBar />;

    const tabStripPlus = (
      <ChatPanelPlusMenu
        onOpenLaunchpad={handleOpenLaunchpadTab}
        onOpenKanban={handleOpenKanbanTab}
        onNewWorkItem={handleStartPageNewWorkItem}
      />
    );

    // Terminal / work-management tabs are not creator surfaces: the create
    // target select and presence button would be launcher noise there. Real
    // creator surfaces (new work item / project / collab org) keep them.
    const showCreatorHeaderControls =
      contentState.showNonSessionContent &&
      !isTerminalTabActive &&
      !isManagementTabActive;

    const { createTargetOptions, handleCreateTargetChange } =
      useChatPanelCreateTarget({
        allAgentDefs,
        handleNewSession,
        sessionCreatorAvailable: Boolean(SessionCreatorSlot),
        setCreateTarget,
        setCreatorState,
        setStartPageOpen,
        setShowProjectAgentCreator,
        setShowWorkItemAgentCreator,
        setWorkItemCreateDraft,
        t,
      });

    const headerSection = (
      <>
        <ChatPanelSurfaceHeaderPublisher
          enabled={publishSurfaceHeader}
          title={contentState.headerTitle}
          titleContent={contentState.headerTitleContent}
          showAgentSwitch={contentState.showExploreContent}
          agentSwitchLabel={t("navigation:labels.agent", {
            defaultValue: "Agent",
          })}
          agentSwitchChecked={exploreAgentSearchEnabled}
          onAgentSwitchChange={handleExploreAgentSearchToggle}
        />
        <ChatPanelHeader
          activeSessionExists={Boolean(activeSession)}
          allBlocksCollapsed={allBlocksCollapsed}
          collapseToggleLabel={collapseToggleLabel}
          copyEventJsonLabel={copyEventJsonLabel}
          createTarget={createTarget}
          createTargetOptions={createTargetOptions}
          currentSessionId={currentSessionId ?? null}
          displayMode={displayMode}
          eventsLength={eventCount}
          exploreAgentSearchEnabled={exploreAgentSearchEnabled}
          handleChatFocusToggle={handleChatFocusToggle}
          handleCompactDisplayModeToggle={handleCompactDisplayModeToggle}
          handleCopyEventJson={handleCopyEventJson}
          handleCreateTargetChange={handleCreateTargetChange}
          handleExploreAgentSearchToggle={handleExploreAgentSearchToggle}
          handleOpenExportSessionJson={handleOpenExportSessionJson}
          handleOpenLinkWorkItem={handleOpenLinkWorkItem}
          handleOpenCloudShareSettings={handleOpenCloudShareSettings}
          handleOpenLinkProject={handleOpenLinkProject}
          handleOpenSearch={handleOpenSearch}
          handleNewSession={handleNewSession}
          handlePaginationToggle={handlePaginationToggle}
          handleProjectAgentCreatorToggle={handleProjectAgentCreatorToggle}
          handleProjectTitleChange={handleProjectTitleChange}
          handleReloadFromMenu={handleReloadFromMenu}
          handleStatusBarVisibleToggle={handleStatusBarVisibleToggle}
          handleToggleAllBlocksCollapsed={handleToggleAllBlocksCollapsed}
          handleTokenUsageVisibleToggle={handleTokenUsageVisibleToggle}
          handleWorkItemAgentCreatorToggle={handleWorkItemAgentCreatorToggle}
          handleWorkItemTitleChange={handleWorkItemTitleChange}
          headerActionsDropdownRef={headerActionsDropdownRef}
          headerActionsPosition={headerActionsPosition}
          headerActionsTriggerRef={headerActionsTriggerRef}
          headerTitle={contentState.headerTitle}
          headerTitleContent={contentState.headerTitleContent}
          isChatFocus={isChatFocus}
          isHeaderActionsOpen={isHeaderActionsOpen}
          isHeaderActionsPositioned={isHeaderActionsPositioned}
          isProjectTarget={contentState.isProjectTarget}
          paginationEnabled={paginationEnabled}
          statusBarVisible={statusBarVisible}
          tokenUsageVisible={tokenUsageVisible}
          showStartPageBackButton={
            !startPageOpen && !contentState.showSessionContent
          }
          selectedProjectVisible={Boolean(selectedProject)}
          selectedWorkItemVisible={Boolean(selectedWorkItem)}
          shouldOffsetHeaderForCollapsedSidebar={
            shouldOffsetHeaderForCollapsedSidebar
          }
          showBenchmarkSessionGroupContent={
            contentState.showBenchmarkSessionGroupContent
          }
          showChatFocusToggle={showChatFocusToggle}
          showCreatorPresenceInHeader={contentState.showCreatorPresenceInHeader}
          showHeader={contentState.showHeader || isManagementTabActive}
          showExploreAgentSwitchInHeader={contentState.showExploreContent}
          showNewSessionButton={contentState.showNewSessionButton}
          showNonSessionContent={showCreatorHeaderControls}
          showProjectAgentCreator={showProjectAgentCreator}
          showProjectAgentSwitchInHeader={
            contentState.showProjectAgentSwitchInHeader
          }
          showSessionContent={
            contentState.showSessionContent && !isManagementTabActive
          }
          showCloudShareSettings={showCloudShareSettings}
          showStartPage={startPageOpen}
          showWorkItemAgentCreator={showWorkItemAgentCreator}
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
          showWorkItemAgentSwitchInHeader={
            contentState.showWorkItemAgentSwitchInHeader
          }
          t={t}
          toggleHeaderActionsMenu={toggleHeaderActionsMenu}
          visibleRegionNotice={regionNotice}
        />
      </>
    );

    const chatColumn = (
      <ChatPanelContent
        currentSessionId={currentSessionId ?? null}
        displayMode={displayMode}
        emptyChatContent={emptyChatContent}
        handleRegisterSearchOpen={handleRegisterSearchOpen}
        paginationEnabled={paginationEnabled}
        position={position}
        selectedCloudOrg={selectedCloudOrg}
        selectedProject={selectedProject}
        selectedProjectOrg={selectedProjectOrg}
        selectedWorkItem={selectedWorkItem}
        selectedWorkspace={selectedWorkspace}
        showBenchmarkSessionGroupContent={
          contentState.showBenchmarkSessionGroupContent
        }
        showCloudOrgContent={contentState.showCloudOrgContent}
        showExploreContent={contentState.showExploreContent}
        showPanelContent={contentState.showPanelContent}
        showProjectContent={contentState.showProjectContent}
        showProjectOrgContent={contentState.showProjectOrgContent}
        showSessionContent={contentState.showSessionContent}
        showWorkItemContent={contentState.showWorkItemContent}
        showWorkspaceOverviewContent={contentState.showWorkspaceOverviewContent}
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

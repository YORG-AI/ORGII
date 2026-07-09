import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  Gauge,
  LayoutDashboard,
  ListTodo,
  Search,
  UsersRound,
  Workflow,
} from "lucide-react";
import React, { memo, useCallback, useMemo, useState } from "react";
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
import type { CreatedOrgResult } from "@src/features/TeamCollaboration/components/CreateCollabOrgView";
import { useShouldOffsetChatPanelHeader } from "@src/hooks/ui/sidebar/useCollapsedSidebarChromeOffset";
import { allAgentDefsAtom } from "@src/modules/MainApp/AgentOrgs/store/builtInAgentsAtom";
import { useIsCompactLayout } from "@src/modules/shared/layouts/useCompactLayout";
import { getChatPanelBackgroundStyle } from "@src/modules/shared/layouts/viewContainerTokens";
import {
  collabConnectionStatesAtom,
  collabMembersAtom,
  collabOrgsAtom,
  remoteTeammateSessionsAtom,
} from "@src/store/collaboration/collabOrgsAtom";
import { projectListRefreshAtom } from "@src/store/project/projectAtom";
import { sessionCreatorStateAtom } from "@src/store/session";
import { tuiModeAtom } from "@src/store/session/tuiModeAtom";
import { resolvedBackgroundConfigAtom } from "@src/store/ui/backgroundConfigAtom";
import {
  chatPanelContentModeAtom,
  chatPanelCreateProjectContextAtom,
  chatPanelCreateTargetAtom,
  chatPanelExploreOpenAtom,
  chatPanelManageIssuesOpenAtom,
  chatPanelMaximizedAtom,
  chatPanelSelectedCollabOrgAtom,
  chatPanelSelectedProjectAtom,
  chatPanelSelectedProjectOrgAtom,
  chatPanelSelectedWorkItemAtom,
  chatPanelSelectedWorkspaceAtom,
  chatPanelStartPageOpenAtom,
  chatPanelWorkspaceDashboardOpenAtom,
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
import { ChatPanelPlusMenu, ChatPanelTabBar } from "./ChatPanelTabBar";
import { ChatPanelSurfaceHeaderPublisher } from "./header";
import { useAiWorkItemCreator } from "./hooks/useAiWorkItemCreator";
import { useChatPanelContentState } from "./hooks/useChatPanelContentState";
import { useChatPanelCreateTarget } from "./hooks/useChatPanelCreateTarget";
import { useChatPanelHeaderActions } from "./hooks/useChatPanelHeaderActions";
import { useChatPanelNavigationActions } from "./hooks/useChatPanelNavigationActions";
import { useChatPanelResize } from "./hooks/useChatPanelResize";
import { useChatPanelSessionModals } from "./hooks/useChatPanelSessionModals";
import { useChatPanelTabsController } from "./hooks/useChatPanelTabsController";
import { useCollabOrgHeaderModel } from "./hooks/useCollabOrgHeaderModel";
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
    const isCompactLayout = useIsCompactLayout();
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
    const selectedCollabOrg = useAtomValue(chatPanelSelectedCollabOrgAtom);
    const collabOrgs = useAtomValue(collabOrgsAtom);
    const collabMembers = useAtomValue(collabMembersAtom);
    const collabConnectionStates = useAtomValue(collabConnectionStatesAtom);
    const remoteTeammateSessions = useAtomValue(remoteTeammateSessionsAtom);
    const workspaceDashboardOpen = useAtomValue(
      chatPanelWorkspaceDashboardOpenAtom
    );
    const exploreOpen = useAtomValue(chatPanelExploreOpenAtom);
    const manageIssuesOpen = useAtomValue(chatPanelManageIssuesOpenAtom);
    const createProjectContext = useAtomValue(
      chatPanelCreateProjectContextAtom
    );

    const isChatFocus = useAtomValue(chatPanelMaximizedAtom);
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
      openCollabOrgSurface,
      openManageIssues,
      openStartPage,
      openWorkItemCreate,
      openWorkspaceDashboard,
      openWorkspaceExplore,
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
      isTerminalTabActive,
      terminalTabs,
    } = useChatPanelTabsController({
      currentSessionId: currentSessionId ?? null,
      panelTitle,
      resetToSessionSurface,
      showSessionSurface,
    });

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
      handleToggleAllBlocksCollapsed,
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

    const collapseToggleLabel = allBlocksCollapsed
      ? t("common:actions.expandAll")
      : t("common:actions.collapseAll");

    const handleNewSession = resetToSessionSurface;
    const handleOpenStartPage = openStartPage;
    const handleStartPageNewWorkItem = openWorkItemCreate;
    const handleStartPageSetupRepo = openWorkspaceDashboard;
    const handleStartPageExploreRepos = openWorkspaceExplore;
    const handleStartPageManageIssues = openManageIssues;

    const handleChatPanelCollabOrgCreated = useCallback(
      (result: CreatedOrgResult) => {
        if (result.source === "supabase") {
          openCollabOrgSurface(result.org.id);
        } else {
          bumpProjectListRefresh((previous) => previous + 1);
          showSessionSurface();
        }
        resetActiveSession();
      },
      [
        bumpProjectListRefresh,
        openCollabOrgSurface,
        resetActiveSession,
        showSessionSurface,
      ]
    );

    const handleStartPageAddApiKey = useCallback(() => {
      const accountsPath = `${buildIntegrationsPath({ category: "models" })}?modelsTab=my-accounts`;
      navigate(buildWizardPath(accountsPath, WIZARD_IDS.KEY_ADD));
    }, [navigate]);

    const sessionSidebarVisible = sessionSidebarWidth > 0;
    const collabOrgHeader = useCollabOrgHeaderModel({
      collabConnectionStates,
      collabMembers,
      collabOrgs,
      remoteTeammateSessions,
      selectedCollabOrg,
      t,
    });
    const contentState = useChatPanelContentState({
      active,
      contentMode,
      createTarget,
      currentSessionId: currentSessionId ?? null,
      exploreOpen,
      manageIssuesOpen,
      isChatFocus,
      panelTitle,
      collabOrgHeaderTitle: collabOrgHeader?.title,
      collabOrgHeaderTitleContent: collabOrgHeader?.titleContent,
      selectedCollabOrg,
      selectedProject,
      selectedProjectOrg,
      selectedWorkItem,
      selectedWorkspace,
      workspaceDashboardOpen,
      showChatFocusToggle,
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
      sessionModals,
    } = useChatPanelSessionModals({
      activeSession,
      closeHeaderActionsMenu,
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
    const chatFocusLabel = isChatFocus
      ? t("chat.showWorkstation")
      : t("chat.maximizeChatPanel");
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
        handleStartPageExploreRepos={handleStartPageExploreRepos}
        handleStartPageManageIssues={handleStartPageManageIssues}
        handleStartPageNewSession={handleNewSession}
        handleStartPageNewWorkItem={handleStartPageNewWorkItem}
        handleStartPageSetupRepo={handleStartPageSetupRepo}
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
      startPageOpen ||
      contentState.showBenchmarkSessionGroupContent ||
      contentState.showExploreContent ||
      contentState.showManageIssuesContent ||
      contentState.showWorkspaceDashboardContent ||
      contentState.showCollabOrgContent ||
      contentState.showWorkspaceOverviewContent;

    const surfaceTabChrome = useMemo(() => {
      if (startPageOpen) {
        return {
          title: t("navigation:launchpad.dashboard"),
          icon: <LayoutDashboard size={16} strokeWidth={1.75} />,
        };
      }
      if (contentState.showManageIssuesContent) {
        return {
          title: t("chat.manageIssues.title"),
          icon: <ListTodo size={16} strokeWidth={1.75} />,
        };
      }
      if (contentState.showExploreContent) {
        return {
          title: t("navigation:explore.title", { defaultValue: "Explore" }),
          icon: <Search size={16} strokeWidth={1.75} />,
        };
      }
      if (contentState.showWorkspaceDashboardContent) {
        return {
          title: t("navigation:launchpad.dashboard"),
          icon: <LayoutDashboard size={16} strokeWidth={1.75} />,
        };
      }
      if (contentState.showCollabOrgContent) {
        return {
          title: contentState.headerTitle,
          icon: <UsersRound size={16} strokeWidth={1.75} />,
        };
      }
      if (contentState.showWorkspaceOverviewContent) {
        return {
          title: contentState.headerTitle,
          icon: <Workflow size={16} strokeWidth={1.75} />,
        };
      }
      if (contentState.showBenchmarkSessionGroupContent) {
        return {
          title: contentState.headerTitle,
          icon: <Gauge size={16} strokeWidth={1.75} />,
        };
      }
      return null;
    }, [
      contentState.headerTitle,
      contentState.showBenchmarkSessionGroupContent,
      contentState.showCollabOrgContent,
      contentState.showExploreContent,
      contentState.showManageIssuesContent,
      contentState.showWorkspaceDashboardContent,
      contentState.showWorkspaceOverviewContent,
      startPageOpen,
      t,
    ]);

    const tabStrip = (
      <ChatPanelTabBar
        onNewSession={handleNewSessionTab}
        onNewTerminal={handleNewTerminalTab}
        containerRef={panelRef}
      />
    );

    const tabStripPlus = (
      <ChatPanelPlusMenu
        onNewSession={handleNewSessionTab}
        onNewWorkItem={handleStartPageNewWorkItem}
        onManageIssues={handleStartPageManageIssues}
        onAddApiKey={handleStartPageAddApiKey}
      />
    );

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
          tabTitle={surfaceTabChrome?.title}
          tabIcon={surfaceTabChrome?.icon}
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
          handleOpenSearch={handleOpenSearch}
          handleNewSession={handleNewSession}
          handleOpenStartPage={handleOpenStartPage}
          handlePaginationToggle={handlePaginationToggle}
          handleProjectAgentCreatorToggle={handleProjectAgentCreatorToggle}
          handleProjectTitleChange={handleProjectTitleChange}
          handleReloadFromMenu={handleReloadFromMenu}
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
          isCompactLayout={isCompactLayout}
          isHeaderActionsOpen={isHeaderActionsOpen}
          isHeaderActionsPositioned={isHeaderActionsPositioned}
          isProjectTarget={contentState.isProjectTarget}
          paginationEnabled={paginationEnabled}
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
          showHeader={contentState.showHeader}
          showExploreAgentSwitchInHeader={contentState.showExploreContent}
          showNewSessionButton={contentState.showNewSessionButton}
          showNonSessionContent={contentState.showNonSessionContent}
          showProjectAgentCreator={showProjectAgentCreator}
          showProjectAgentSwitchInHeader={
            contentState.showProjectAgentSwitchInHeader
          }
          showSessionContent={contentState.showSessionContent}
          showStartPage={startPageOpen}
          showWorkItemAgentCreator={showWorkItemAgentCreator}
          showTuiModeToggle={showTuiModeToggle}
          tuiMode={tuiMode}
          handleTuiModeToggle={handleTuiModeToggle}
          tabStrip={tabStrip}
          tabStripPlus={tabStripPlus}
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
        chatFocusLabel={chatFocusLabel}
        currentSessionId={currentSessionId ?? null}
        displayMode={displayMode}
        emptyChatContent={emptyChatContent}
        handleChatFocusToggle={handleChatFocusToggle}
        handleRegisterSearchOpen={handleRegisterSearchOpen}
        paginationEnabled={paginationEnabled}
        position={position}
        selectedCollabOrg={selectedCollabOrg}
        selectedProject={selectedProject}
        selectedProjectOrg={selectedProjectOrg}
        selectedWorkItem={selectedWorkItem}
        selectedWorkspace={selectedWorkspace}
        showBenchmarkSessionGroupContent={
          contentState.showBenchmarkSessionGroupContent
        }
        showCollabOrgContent={contentState.showCollabOrgContent}
        showEmptyChatFocusRestoreButton={
          contentState.showEmptyChatFocusRestoreButton
        }
        showExploreContent={contentState.showExploreContent}
        showManageIssuesContent={contentState.showManageIssuesContent}
        showPanelContent={contentState.showPanelContent}
        showProjectContent={contentState.showProjectContent}
        showProjectOrgContent={contentState.showProjectOrgContent}
        showSessionContent={contentState.showSessionContent}
        showWorkItemContent={contentState.showWorkItemContent}
        showWorkspaceDashboardContent={
          contentState.showWorkspaceDashboardContent
        }
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

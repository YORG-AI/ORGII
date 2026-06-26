import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import {
  WIZARD_IDS,
  buildIntegrationsPath,
  buildWizardPath,
} from "@src/config/mainAppPaths";
import { useRouteViewMode } from "@src/config/routeViewModeConfig";
import {
  MAX_WIDTH as CHAT_MAX_WIDTH,
  MIN_WIDTH as CHAT_MIN_WIDTH,
} from "@src/engines/ChatPanel/config";
import {
  clearSessionAtom,
  eventCountAtom,
  eventsAtom,
} from "@src/engines/SessionCore/core/atoms";
import type { CreatedOrgResult } from "@src/features/TeamCollaboration/components/CreateCollabOrgView";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { useShouldOffsetChatPanelHeader } from "@src/hooks/ui/sidebar/useCollapsedSidebarChromeOffset";
import { allAgentDefsAtom } from "@src/modules/MainApp/AgentOrgs/store/builtInAgentsAtom";
import { useIsCompactLayout } from "@src/modules/shared/layouts/useCompactLayout";
import { getChatPanelBackgroundStyle } from "@src/modules/shared/layouts/viewContainerTokens";
import { VerticalResizeHandle } from "@src/scaffold/Resize";
import { GUIDE_TARGETS } from "@src/scaffold/Tutorials";
import {
  collabConnectionStatesAtom,
  collabMembersAtom,
  collabOrgsAtom,
  remoteTeammateSessionsAtom,
} from "@src/store/collaboration/collabOrgsAtom";
import {
  COLLAB_CONNECTION_STATUS,
  type CollabConnectionStatus,
} from "@src/store/collaboration/types";
import { projectListRefreshAtom } from "@src/store/project/projectAtom";
import {
  activeSessionIdAtom,
  sessionCreatorStateAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session";
import { resolvedBackgroundConfigAtom } from "@src/store/ui/backgroundConfigAtom";
import {
  CHAT_PANEL_SURFACE_KIND,
  chatHistoryDisplayModeAtom,
  chatPanelContentModeAtom,
  chatPanelCreateProjectContextAtom,
  chatPanelCreateTargetAtom,
  chatPanelExploreAgentSearchEnabledAtom,
  chatPanelExploreOpenAtom,
  chatPanelManageIssuesOpenAtom,
  chatPanelMaximizedAtom,
  chatPanelNavigateAtom,
  chatPanelSelectedCollabOrgAtom,
  chatPanelSelectedProjectAtom,
  chatPanelSelectedProjectOrgAtom,
  chatPanelSelectedWorkItemAtom,
  chatPanelSelectedWorkspaceAtom,
  chatPanelStartPageOpenAtom,
  chatPanelWorkspaceDashboardOpenAtom,
  chatTurnPaginationEnabledAtom,
  chatWidthAtom,
  toggleChatPanelMaximizedAtom,
} from "@src/store/ui/chatPanelAtom";
import {
  collapseAllCommandAtom,
  setAllBlocksCollapsedAtom,
} from "@src/store/ui/collapseStateAtom";
import { sidebarCollapsedAtom } from "@src/store/ui/sidebarAtom";
import type { WorkItemDraft } from "@src/store/workstation/projectManager";

import { useReloadSession } from "./ChatHistory/hooks/useReloadSession";
import { ChatPanelContent } from "./ChatPanelContent";
import { ChatPanelEmptyContent } from "./ChatPanelEmptyContent";
import { ChatPanelHeader } from "./ChatPanelHeader";
import {
  ChatPanelHeaderBreadcrumb,
  ChatPanelSurfaceHeaderPublisher,
} from "./header";
import { useAiWorkItemCreator } from "./hooks/useAiWorkItemCreator";
import { useChatPanelContentState } from "./hooks/useChatPanelContentState";
import { useChatPanelCreateTarget } from "./hooks/useChatPanelCreateTarget";
import { useChatPanelResize } from "./hooks/useChatPanelResize";
import { useChatPanelSessionModals } from "./hooks/useChatPanelSessionModals";
import { usePanelTitle } from "./hooks/usePanelTitle";
import { useProjectWorkItemHandlers } from "./hooks/useProjectWorkItemHandlers";
import type { ChatPanelProps, ChatPanelRegionNotice } from "./types";

const COLLAB_HEADER_STATUS_COLOR: Record<CollabConnectionStatus, string> = {
  [COLLAB_CONNECTION_STATUS.CONNECTED]: "bg-success-6",
  [COLLAB_CONNECTION_STATUS.CONNECTING]: "bg-warning-6",
  [COLLAB_CONNECTION_STATUS.DISCONNECTED]: "bg-fill-4",
  [COLLAB_CONNECTION_STATUS.ERROR]: "bg-danger-6",
};

function CollabHeaderStatusPill({
  label,
  status,
}: {
  label: string;
  status: CollabConnectionStatus;
}): React.ReactNode {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-fill-2 px-2 py-0.5 text-[11px] font-medium text-text-2">
      <span
        className={`h-1.5 w-1.5 rounded-full ${COLLAB_HEADER_STATUS_COLOR[status]}`}
      />
      {label}
    </span>
  );
}

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
    const [startPageOpen, setStartPageOpen] = useAtom(
      chatPanelStartPageOpenAtom
    );
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
    const backgroundConfig = useAtomValue(resolvedBackgroundConfigAtom);
    const chatPanelOpacityStyle = React.useMemo(
      () => getChatPanelBackgroundStyle(backgroundConfig.pageOpacity),
      [backgroundConfig.pageOpacity]
    );
    const chatWidth =
      rawChatWidth > 0 ? Math.min(rawChatWidth, CHAT_MAX_WIDTH) : rawChatWidth;
    const { isDragging, panelRef, handleMouseDown } = useChatPanelResize({
      useExternalWidth,
      embedded,
      position,
    });

    const handleChatFocusToggle = useCallback(() => {
      toggleChatFocus();
    }, [toggleChatFocus]);

    const openSearchRef = React.useRef<(() => void) | null>(null);
    const {
      isOpen: isHeaderActionsOpen,
      isPositioned: isHeaderActionsPositioned,
      toggle: toggleHeaderActionsMenu,
      close: closeHeaderActionsMenu,
      triggerRef: headerActionsTriggerRef,
      panelRef: headerActionsDropdownRef,
      panelPosition: headerActionsPosition,
    } = useDropdownEngine<HTMLButtonElement>({
      gap: 4,
      align: "right",
      placement: "bottom",
    });

    const [regionNotice, setRegionNotice] =
      React.useState<ChatPanelRegionNotice | null>(null);
    const handleRegionNoticeChange = useCallback(
      (notice: ChatPanelRegionNotice | null) => {
        setRegionNotice(notice);
      },
      []
    );

    const [paginationEnabled, setPaginationEnabled] = useAtom(
      chatTurnPaginationEnabledAtom
    );
    const [displayMode, setDisplayMode] = useAtom(chatHistoryDisplayModeAtom);
    const [exploreAgentSearchEnabled, setExploreAgentSearchEnabled] = useAtom(
      chatPanelExploreAgentSearchEnabledAtom
    );
    const collapseAllCommand = useAtomValue(collapseAllCommandAtom);
    const setAllBlocksCollapsed = useSetAtom(setAllBlocksCollapsedAtom);
    const setActiveSessionId = useSetAtom(activeSessionIdAtom);
    const navigateChatPanel = useSetAtom(chatPanelNavigateAtom);
    const setWorkstationActiveSessionId = useSetAtom(
      workstationActiveSessionIdAtom
    );
    const setSelectedWorkItem = useSetAtom(chatPanelSelectedWorkItemAtom);
    const setSelectedProject = useSetAtom(chatPanelSelectedProjectAtom);
    const dispatchClearSession = useSetAtom(clearSessionAtom);
    const creatorState = useAtomValue(sessionCreatorStateAtom);
    const setCreatorState = useSetAtom(sessionCreatorStateAtom);
    const bumpProjectListRefresh = useSetAtom(projectListRefreshAtom);
    const allAgentDefs = useAtomValue(allAgentDefsAtom);
    const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);

    const allBlocksCollapsed =
      collapseAllCommand.epoch > 0 ? collapseAllCommand.collapsed : false;
    const collapseToggleLabel = allBlocksCollapsed
      ? t("common:actions.expandAll")
      : t("common:actions.collapseAll");

    const handleToggleAllBlocksCollapsed = useCallback(() => {
      setAllBlocksCollapsed(!allBlocksCollapsed);
      closeHeaderActionsMenu();
    }, [allBlocksCollapsed, closeHeaderActionsMenu, setAllBlocksCollapsed]);

    const handleRegisterSearchOpen = useCallback(
      (handler: (() => void) | null) => {
        openSearchRef.current = handler;
      },
      []
    );

    const handleOpenSearch = useCallback(() => {
      openSearchRef.current?.();
      closeHeaderActionsMenu();
    }, [closeHeaderActionsMenu]);

    const handleReloadFromMenu = useCallback(() => {
      handleReloadSession();
      closeHeaderActionsMenu();
    }, [closeHeaderActionsMenu, handleReloadSession]);

    const handlePaginationToggle = useCallback(
      (checked: boolean) => {
        setPaginationEnabled(checked);
      },
      [setPaginationEnabled]
    );

    const handleExploreAgentSearchToggle = useCallback(
      (checked: boolean) => {
        setExploreAgentSearchEnabled(checked);
      },
      [setExploreAgentSearchEnabled]
    );

    const handleCompactDisplayModeToggle = useCallback(
      (checked: boolean) => {
        setDisplayMode(checked ? "compact" : "full");
      },
      [setDisplayMode]
    );

    const handleNewSession = useCallback(() => {
      setStartPageOpen(false);
      navigateChatPanel({ kind: CHAT_PANEL_SURFACE_KIND.SESSION });
      dispatchClearSession();
      setWorkstationActiveSessionId(null);
      setActiveSessionId(null);
    }, [
      dispatchClearSession,
      navigateChatPanel,
      setActiveSessionId,
      setStartPageOpen,
      setWorkstationActiveSessionId,
    ]);

    const handleOpenStartPage = useCallback(() => {
      navigateChatPanel({ kind: CHAT_PANEL_SURFACE_KIND.SESSION });
      setStartPageOpen(true);
      dispatchClearSession();
      setWorkstationActiveSessionId(null);
      setActiveSessionId(null);
    }, [
      dispatchClearSession,
      navigateChatPanel,
      setActiveSessionId,
      setStartPageOpen,
      setWorkstationActiveSessionId,
    ]);

    const handleChatPanelCollabOrgCreated = useCallback(
      (result: CreatedOrgResult) => {
        if (result.source === "supabase") {
          navigateChatPanel({
            kind: CHAT_PANEL_SURFACE_KIND.COLLAB_ORG,
            collabOrg: { orgId: result.org.id },
          });
        } else {
          bumpProjectListRefresh((previous) => previous + 1);
          navigateChatPanel({ kind: CHAT_PANEL_SURFACE_KIND.SESSION });
        }
        dispatchClearSession();
        setWorkstationActiveSessionId(null);
        setActiveSessionId(null);
      },
      [
        bumpProjectListRefresh,
        dispatchClearSession,
        navigateChatPanel,
        setActiveSessionId,
        setWorkstationActiveSessionId,
      ]
    );

    const eventCount = useAtomValue(eventCountAtom);
    const events = useAtomValue(eventsAtom);
    const [copyEventJsonLabel, setCopyEventJsonLabel] = React.useState<
      "idle" | "copied" | "failed"
    >("idle");
    const handleCopyEventJson = useCallback(() => {
      const json = JSON.stringify(events, null, 2);
      navigator.clipboard
        .writeText(json)
        .then(() => {
          setCopyEventJsonLabel("copied");
          setTimeout(() => setCopyEventJsonLabel("idle"), 2000);
        })
        .catch(() => {
          setCopyEventJsonLabel("failed");
          setTimeout(() => setCopyEventJsonLabel("idle"), 2000);
        });
      closeHeaderActionsMenu();
    }, [closeHeaderActionsMenu, events]);

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

    const handleStartPageNewWorkItem = useCallback(() => {
      setStartPageOpen(false);
      navigateChatPanel({ kind: CHAT_PANEL_SURFACE_KIND.NEW_WORK_ITEM });
      dispatchClearSession();
      setWorkstationActiveSessionId(null);
      setActiveSessionId(null);
    }, [
      dispatchClearSession,
      navigateChatPanel,
      setActiveSessionId,
      setStartPageOpen,
      setWorkstationActiveSessionId,
    ]);

    const handleStartPageSetupRepo = useCallback(() => {
      setStartPageOpen(false);
      navigateChatPanel({ kind: CHAT_PANEL_SURFACE_KIND.WORKSPACE_DASHBOARD });
      dispatchClearSession();
      setWorkstationActiveSessionId(null);
      setActiveSessionId(null);
    }, [
      dispatchClearSession,
      navigateChatPanel,
      setActiveSessionId,
      setStartPageOpen,
      setWorkstationActiveSessionId,
    ]);

    const handleStartPageExploreRepos = useCallback(() => {
      setStartPageOpen(false);
      navigateChatPanel({ kind: CHAT_PANEL_SURFACE_KIND.WORKSPACE_EXPLORE });
      dispatchClearSession();
      setWorkstationActiveSessionId(null);
      setActiveSessionId(null);
    }, [
      dispatchClearSession,
      navigateChatPanel,
      setActiveSessionId,
      setStartPageOpen,
      setWorkstationActiveSessionId,
    ]);

    const handleStartPageManageIssues = useCallback(() => {
      setStartPageOpen(false);
      navigateChatPanel({ kind: CHAT_PANEL_SURFACE_KIND.MANAGE_ISSUES });
      dispatchClearSession();
      setWorkstationActiveSessionId(null);
      setActiveSessionId(null);
    }, [
      dispatchClearSession,
      navigateChatPanel,
      setActiveSessionId,
      setStartPageOpen,
      setWorkstationActiveSessionId,
    ]);

    const handleStartPageAddApiKey = useCallback(() => {
      const accountsPath = `${buildIntegrationsPath({ category: "models" })}?modelsTab=my-accounts`;
      navigate(buildWizardPath(accountsPath, WIZARD_IDS.KEY_ADD));
    }, [navigate]);

    const sessionSidebarVisible = sessionSidebarWidth > 0;
    const collabOrgHeader = React.useMemo(() => {
      if (!selectedCollabOrg) return null;
      const org = collabOrgs.find(
        (candidate) => candidate.id === selectedCollabOrg.orgId
      );
      const orgMembers = collabMembers.filter(
        (member) =>
          member.orgId === selectedCollabOrg.orgId && !member.removedAt
      );
      const selectedMember = selectedCollabOrg.memberId
        ? orgMembers.find((member) => member.id === selectedCollabOrg.memberId)
        : null;
      const orgSessions = remoteTeammateSessions.filter(
        (session) => session.orgId === selectedCollabOrg.orgId
      );
      const connectionState = collabConnectionStates.find(
        (state) => state.orgId === selectedCollabOrg.orgId
      );
      const activeMemberIds = new Set(
        orgSessions
          .filter((session) => {
            if (!session.lastActivityAt) return false;
            const date = new Date(session.lastActivityAt);
            if (Number.isNaN(date.getTime())) return false;
            const now = new Date();
            return (
              date.getFullYear() === now.getFullYear() &&
              date.getMonth() === now.getMonth() &&
              date.getDate() === now.getDate()
            );
          })
          .map((session) => session.ownerMemberId)
      );
      const connected =
        connectionState?.status === COLLAB_CONNECTION_STATUS.CONNECTED;
      const status: CollabConnectionStatus = selectedMember
        ? activeMemberIds.has(selectedMember.id)
          ? COLLAB_CONNECTION_STATUS.CONNECTED
          : COLLAB_CONNECTION_STATUS.DISCONNECTED
        : (connectionState?.status ?? COLLAB_CONNECTION_STATUS.DISCONNECTED);
      const statusLabel = selectedMember
        ? activeMemberIds.has(selectedMember.id)
          ? t("navigation:collaboration.status.activeToday")
          : t("navigation:collaboration.status.idle")
        : connected
          ? t("navigation:collaboration.status.connected")
          : t("navigation:collaboration.status.offline");
      const orgTitle = org?.name ?? t("navigation:collaboration.orgDemoTitle");
      const title = selectedMember?.displayName ?? orgTitle;
      const breadcrumbItems = selectedMember
        ? [
            { key: "org", label: orgTitle },
            { key: "member", label: selectedMember.displayName },
          ]
        : [{ key: "org", label: orgTitle }];
      const titleContent = (
        <ChatPanelHeaderBreadcrumb
          items={breadcrumbItems}
          trailing={
            <CollabHeaderStatusPill label={statusLabel} status={status} />
          }
        />
      );
      return { title, titleContent };
    }, [
      collabConnectionStates,
      collabMembers,
      collabOrgs,
      remoteTeammateSessions,
      selectedCollabOrg,
      t,
    ]);
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

    const showResizeHandle = !useExternalWidth;
    const borderClasses =
      embedded && !showResizeHandle
        ? isLeftPosition
          ? "border-r border-border-1"
          : "border-l border-border-1"
        : "";
    const dragHandle = showResizeHandle && (
      <VerticalResizeHandle
        key="chat-panel-resize-handle"
        onMouseDown={handleMouseDown}
        variant={embedded ? "border" : "transparent"}
        noAccent={!embedded}
      />
    );

    const chatFocusLabel = isChatFocus
      ? t("chat.showWorkstation")
      : t("chat.maximizeChatPanel");
    const useFullScreenCreator =
      isChatFocus || useExternalWidth || chatWidth >= CHAT_MAX_WIDTH;
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
      contentState.showBenchmarkSessionGroupContent ||
      contentState.showExploreContent ||
      contentState.showManageIssuesContent ||
      contentState.showWorkspaceDashboardContent ||
      contentState.showCollabOrgContent ||
      contentState.showWorkspaceOverviewContent;

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
          handleOpenSearch={handleOpenSearch}
          handleNewSession={handleNewSession}
          handleOpenStartPage={handleOpenStartPage}
          handlePaginationToggle={handlePaginationToggle}
          handleProjectAgentCreatorToggle={handleProjectAgentCreatorToggle}
          handleProjectTitleChange={handleProjectTitleChange}
          handleReloadFromMenu={handleReloadFromMenu}
          handleToggleAllBlocksCollapsed={handleToggleAllBlocksCollapsed}
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

    const mainPanel = (
      <div
        key="chat-panel-main"
        ref={panelRef}
        data-chat-panel
        data-testid="chat-panel"
        data-guide-target={GUIDE_TARGETS.CHAT_PANEL}
        className={`relative flex h-full max-w-full flex-col overflow-hidden bg-chat-pane text-sm ${
          useExternalWidth ? "min-w-0 flex-1" : "flex-shrink-0"
        } ${borderClasses}`}
        style={{
          ...(useExternalWidth ? { width: "100%" } : { width: chatWidth }),
          minWidth:
            !useExternalWidth && chatWidth > 0 ? CHAT_MIN_WIDTH : undefined,
          borderRadius: embedded ? 0 : "var(--radius-page)",
          contain: isDragging ? "strict" : undefined,
          willChange: isDragging ? "width" : undefined,
          ...chatPanelOpacityStyle,
        }}
      >
        {headerSection}
        {chatColumn}
      </div>
    );

    const panelChildren = isLeftPosition
      ? [mainPanel, dragHandle]
      : [dragHandle, mainPanel];

    return (
      <>
        <div
          className={`relative flex h-full flex-row ${useExternalWidth ? "w-full min-w-0" : "flex-shrink-0"}`}
        >
          {panelChildren}
        </div>
        {sessionModals}
      </>
    );
  }
);

ChatPanel.displayName = "ChatPanel";

export default ChatPanel;

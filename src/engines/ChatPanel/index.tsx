import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { projectApi } from "@src/api/http/project";
import {
  WIZARD_IDS,
  buildIntegrationsPath,
  buildWizardPath,
} from "@src/config/mainAppPaths";
import {
  CHAT_WIDTH_CSS_VAR,
  clampChatWidth,
  getChatMaxWidth,
} from "@src/engines/ChatPanel/config";
import SessionCommentsHeaderExtras from "@src/features/Org2Cloud/SessionComments/SessionCommentsHeaderExtras";
import SessionViewersIndicator from "@src/features/Org2Cloud/SessionViewersIndicator";
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
  closeOrganizationChatPanelTabAtom,
  closeProjectOrgChatPanelTabsAtom,
  closeRevokedCloudChannelChatPanelTabsAtom,
  isChatPanelTabStationAvailable,
  openRuntimeInChatPanelTabAtom,
  openSessionInNewChatTabAtom,
  patchChatPanelWorkItemTabAtom,
  resolveChatPanelMaximizedForLayout,
  syncActiveChatPanelTabStateAtom,
  toggleActiveChatPanelMaximizedAtom,
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
  chatPanelCollabOrgCreateIntentAtom,
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
} from "@src/store/ui/chatPanelAtom";
import type { WorkItemDraft } from "@src/store/workstation/projectManager";
import { isHumanSession } from "@src/util/session/sessionDispatch";

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
import SessionContinueCliHeaderExtras from "./SessionContinueCliHeaderExtras";
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
  CHAT_PANEL_HEADER_STACK_HEIGHT_PX,
  shouldOverlayChatSessionHeaders,
} from "./header/chatPanelHeaderLayout";
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
import { useSessionViewMode } from "./hooks/useSessionViewMode";
import type { ChatPanelProps, ChatPanelRegionNotice } from "./types";

const ChatPanel: React.FC<ChatPanelProps> = memo(
  ({
    viewportWidth,
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
    const [createTarget, setCreateTarget] = useAtom(chatPanelCreateTargetAtom);
    const setCollabOrgCreateIntent = useSetAtom(
      chatPanelCollabOrgCreateIntentAtom
    );
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
    const closeOrganizationTab = useSetAtom(closeOrganizationChatPanelTabAtom);
    const closeProjectOrgTabs = useSetAtom(closeProjectOrgChatPanelTabsAtom);
    const closeRevokedCloudChannelTabs = useSetAtom(
      closeRevokedCloudChannelChatPanelTabsAtom
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
        closeOrganizationTab();
      }
    }, [closeOrganizationTab, cloudOrgs, cloudOrgsLoaded, selectedCloudOrg]);

    // `project_orgs` is a durable local mirror, not an authorization source.
    // Once the managed-cloud roster is authoritative, close any cached detail
    // tabs whose alias no longer maps to a live membership. The create pickers
    // apply the same boundary in projectOrgVisibility.
    useEffect(() => {
      if (!cloudOrgsLoaded) return undefined;
      let cancelled = false;
      const liveCloudOrgIds = new Set(cloudOrgs.map((org) => org.orgId));
      void projectApi.readOrgs().then((projectOrgs) => {
        if (cancelled) return;
        const revokedProjectOrgIds = projectOrgs
          .filter(
            (org) =>
              org.sync_provider === "orgii_collab" &&
              Boolean(org.external_org_id) &&
              !liveCloudOrgIds.has(org.external_org_id as string)
          )
          .map((org) => org.id);
        closeProjectOrgTabs(revokedProjectOrgIds);
      });
      return () => {
        cancelled = true;
      };
    }, [closeProjectOrgTabs, cloudOrgs, cloudOrgsLoaded]);

    // Channel tabs live in the CLOUD org id space (unlike the project-org
    // aliases above) and per-org reconciliation only covers the active
    // sidebar scope; sweep revoked orgs' channel tabs here once the roster
    // is authoritative.
    useEffect(() => {
      if (!cloudOrgsLoaded) return;
      closeRevokedCloudChannelTabs(cloudOrgs.map((org) => org.orgId));
    }, [closeRevokedCloudChannelTabs, cloudOrgs, cloudOrgsLoaded]);
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

    const {
      dispatchClearSession,
      openProjectCreate,
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
      newSessionTitle: t("sessions:chat.startPage.newSession.title"),
      kanbanTitle: t("sessions:simulator.tabs.kanban"),
      showSessionSurface,
    });
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
    } = useChatPanelHeaderActions({ handleReloadSession });

    const handleReturnToSessionCreator = useCallback(() => {
      handleOpenLaunchpadTab();
      setCreateTarget(CHAT_PANEL_CREATE_TARGET.AGENT_SESSION);
      resetActiveSession();
    }, [handleOpenLaunchpadTab, resetActiveSession, setCreateTarget]);
    const handleStartPageNewWorkItem = openWorkItemCreate;
    const handleStartPageNewProject = openProjectCreate;
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
    const handleShowRuntime = useCallback(() => {
      openRuntimeTab(t("sessions:chat.startPage.tabs.runtime"));
    }, [openRuntimeTab, t]);

    const { createTargetOptions, handleCreateTargetChange } =
      useChatPanelCreateTarget({
        allAgentDefs,
        sessionCreatorAvailable: Boolean(SessionCreatorSlot),
        setCollabOrgCreateIntent,
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

    const setSelectedProject = useSetAtom(chatPanelSelectedProjectAtom);
    const setSelectedWorkItem = useSetAtom(chatPanelSelectedWorkItemAtom);
    const {
      handleCancelCollabOrgCreate,
      handleCancelProjectCreate,
      handleCancelWorkItemCreate,
      handleChatPanelProjectCreated,
      handleChatPanelWorkItemCreated,
      handleProjectAgentCreatorToggle,
      handleWorkItemAgentCreatorToggle,
    } = useProjectWorkItemHandlers({
      bumpProjectListRefresh,
      createProjectContext,
      dispatchClearSession,
      handleReturnToSessionCreator,
      sessionCreatorAvailable: Boolean(SessionCreatorSlot),
      setActiveSessionId,
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
      setActiveSessionId,
      setSelectedProject,
      setWorkItemCreateDraft,
      setWorkstationActiveSessionId,
      workItemCreateDraft,
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
        handleStartPageShowRuntime={handleShowRuntime}
        handleStartPageSessionStart={handleStartPageSessionStart}
        handleProjectAgentCreatorToggle={handleProjectAgentCreatorToggle}
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
        onOpenRuntime={handleShowRuntime}
        onNewProject={handleStartPageNewProject}
        onNewWorkItem={handleStartPageNewWorkItem}
      />
    );

    const overlayChatHeaders = shouldOverlayChatSessionHeaders({
      showSessionContent: contentState.showSessionContent,
      standaloneToolTabActive: isStandaloneToolTabActive,
      humanSessionActive,
    });

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
        handleOpenRawTranscript={sessionView.showRaw}
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
        sessionHeaderExtras={
          <>
            <SessionViewersIndicator sessionId={currentSessionId ?? null} />
            {/* Session-level cloud notes (Phase F) — renders null for
                  non-cloud sessions, exactly like the fork extras. */}
            <SessionCommentsHeaderExtras session={currentSession ?? null} />
            <SessionContinueCliHeaderExtras
              session={currentSession ?? null}
              sessionId={currentSessionId ?? null}
              onOpenCliTerminal={handleOpenCliTerminal}
            />
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
        handleRegisterSearchOpen={handleRegisterSearchOpen}
        onSessionContinuation={handleSessionContinuation}
        paginationEnabled={paginationEnabled}
        position={position}
        showBenchmarkSessionGroupContent={
          contentState.showBenchmarkSessionGroupContent
        }
        showPanelContent={contentState.showPanelContent}
        showSessionContent={contentState.showSessionContent}
        sessionViewMode={sessionView.mode}
        chromeTopInset={
          overlayChatHeaders ? CHAT_PANEL_HEADER_STACK_HEIGHT_PX : 0
        }
        alternateSessionView={
          <SessionAlternateSurface
            sessionId={currentSessionId ?? null}
            view={sessionView}
            topInset={
              overlayChatHeaders ? CHAT_PANEL_HEADER_STACK_HEIGHT_PX : 0
            }
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
                topInset={
                  overlayChatHeaders ? CHAT_PANEL_HEADER_STACK_HEIGHT_PX : 0
                }
              />
            ) : reserveFocusedWorkstationPlaceholder ? (
              <div
                aria-hidden
                data-testid="launchpad-workstation-rail-placeholder"
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

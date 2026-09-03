import type { TFunction } from "i18next";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  WIZARD_IDS,
  buildIntegrationsPath,
  buildWizardPath,
} from "@src/config/mainAppPaths";
import { allAgentDefsAtom } from "@src/modules/MainApp/AgentOrgs/store/builtInAgentsAtom";
import { installAvailableAppUpdate } from "@src/scaffold/AppUpdater";
import { openSessionInNewChatTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { projectListRefreshAtom } from "@src/store/project/projectAtom";
import { sessionCreatorStateAtom } from "@src/store/session";
import {
  CHAT_PANEL_CREATE_TARGET,
  chatPanelCreateProjectContextAtom,
  chatPanelCreateTargetAtom,
  chatPanelSelectedProjectAtom,
  chatPanelSelectedWorkItemAtom,
} from "@src/store/ui/chatPanelAtom";
import type { WorkItemDraft } from "@src/store/workstation/projectManager";

import { ChatPanelEmptyContent } from "../ChatPanelEmptyContent";
import type { ChatPanelProps, ChatPanelRegionNotice } from "../types";
import { useAiWorkItemCreator } from "./useAiWorkItemCreator";
import { useChatPanelCreateTarget } from "./useChatPanelCreateTarget";
import { useChatPanelNavigationActions } from "./useChatPanelNavigationActions";
import type { useChatPanelTabsController } from "./useChatPanelTabsController";
import { useProjectWorkItemHandlers } from "./useProjectWorkItemHandlers";

interface UseChatPanelCreationContentOptions {
  t: TFunction<["sessions", "common", "projects", "navigation"]>;
  startPageOpen: boolean;
  sessionCreatorSlot: ChatPanelProps["sessionCreatorSlot"];
  creatorVariant: "default" | "fullScreen";
  handleShowRuntime: () => void;
  handleOpenLaunchpadTab: () => void;
  handleOpenCliTerminal: ReturnType<
    typeof useChatPanelTabsController
  >["handleOpenCliTerminal"];
  handleRegionNoticeChange: (notice: ChatPanelRegionNotice | null) => void;
}

/**
 * Owns creation workflows at the chat host lifetime, even while the returned
 * surface is not rendered. Moving this state into the conditional creator
 * component would reset in-progress work-item drafts on session/tab switches.
 */
export function useChatPanelCreationContent({
  t,
  startPageOpen,
  sessionCreatorSlot: SessionCreatorSlot,
  creatorVariant,
  handleShowRuntime,
  handleOpenLaunchpadTab,
  handleOpenCliTerminal,
  handleRegionNoticeChange,
}: UseChatPanelCreationContentOptions): React.ReactNode {
  const navigate = useNavigate();
  const {
    dispatchClearSession,
    resetActiveSession,
    setActiveSessionId,
    setWorkstationActiveSessionId,
  } = useChatPanelNavigationActions();
  const [createTarget, setCreateTarget] = useAtom(chatPanelCreateTargetAtom);
  const [workItemCreateDraft, setWorkItemCreateDraft] =
    useState<WorkItemDraft | null>(null);
  const [showWorkItemAgentCreator, setShowWorkItemAgentCreator] = useState(
    Boolean(SessionCreatorSlot)
  );
  const [showProjectAgentCreator, setShowProjectAgentCreator] = useState(
    Boolean(SessionCreatorSlot)
  );
  const createProjectContext = useAtomValue(chatPanelCreateProjectContextAtom);
  const creatorState = useAtomValue(sessionCreatorStateAtom);
  const bumpProjectListRefresh = useSetAtom(projectListRefreshAtom);
  const allAgentDefs = useAtomValue(allAgentDefsAtom);
  const handleReturnToSessionCreator = useCallback(() => {
    handleOpenLaunchpadTab();
    setCreateTarget(CHAT_PANEL_CREATE_TARGET.AGENT_SESSION);
    resetActiveSession();
  }, [handleOpenLaunchpadTab, resetActiveSession, setCreateTarget]);
  const openLaunchedSessionTab = useSetAtom(openSessionInNewChatTabAtom);
  const handleStartPageSessionStart = useCallback(
    (info: { sessionId: string }) => {
      openLaunchedSessionTab({ sessionId: info.sessionId });
    },
    [openLaunchedSessionTab]
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
      sessionCreatorAvailable: Boolean(SessionCreatorSlot),
      setCreateTarget,
      setShowProjectAgentCreator,
      setShowWorkItemAgentCreator,
      setWorkItemCreateDraft,
      t,
    });
  const setSelectedProject = useSetAtom(chatPanelSelectedProjectAtom);
  const setSelectedWorkItem = useSetAtom(chatPanelSelectedWorkItemAtom);
  const {
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
    defaultAiWorkItemExecutionTarget,
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
  const creatorClassName = "min-h-0 flex-1";
  const emptyChatContent = (
    <ChatPanelEmptyContent
      createProjectContext={createProjectContext}
      createTarget={createTarget}
      createTargetOptions={createTargetOptions}
      creatorClassName={creatorClassName}
      creatorVariant={creatorVariant}
      defaultAiWorkItemExecutionTarget={defaultAiWorkItemExecutionTarget}
      handleAiWorkItemSessionStart={handleAiWorkItemSessionStart}
      handleCancelWorkItemCreate={handleCancelWorkItemCreate}
      handleCreateTargetChange={handleCreateTargetChange}
      handleChatPanelProjectCreated={handleChatPanelProjectCreated}
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
  return emptyChatContent;
}

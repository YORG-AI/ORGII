import type { TFunction } from "i18next";
import { useAtomValue, useSetAtom } from "jotai";
import React, { Suspense, useCallback } from "react";

import type { SelectOption } from "@src/components/Select";
import { PRODUCT_MODE_PROJECT } from "@src/config/sessionCreatorConfig";
import type { SessionLaunchSuccessInfo } from "@src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/types";
import { SESSION_CREATOR_LAUNCH_MODE } from "@src/features/SessionCreator/types";
import type { CreatedProjectResult } from "@src/modules/ProjectManager/Projects/components/CreateProjectView";
import type { CreatedWorkItemResult } from "@src/modules/ProjectManager/WorkItems/components/CreateWorkItemView";
import { openOrFocusSessionInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import {
  CHAT_PANEL_CREATE_TARGET,
  type ChatPanelCreateProjectContext,
  type ChatPanelCreateTarget,
} from "@src/store/ui/chatPanelAtom";
import { primaryWorkspaceRootAtom } from "@src/store/workspace";
import {
  PROJECT_CREATOR_DRAFT_ID,
  type WorkItemDraft,
  projectDraftsAtom,
} from "@src/store/workstation/projectManager";
import { STORY_PERSONAL_ORG_FILTER_ID } from "@src/store/workstation/tabs";

import { ChatPanelStartPage } from "./ChatPanelStartPage";
import {
  type DefaultAiWorkItemExecutionTarget,
  StartPageAgentComposer,
} from "./StartPageAgentComposer";
import type { ChatPanelProps, ChatPanelRegionNotice } from "./types";

const CreateProjectView = React.lazy(
  () =>
    import("@src/modules/ProjectManager/Projects/components/CreateProjectView")
);
const CreateWorkItemView = React.lazy(
  () =>
    import("@src/modules/ProjectManager/WorkItems/components/CreateWorkItemView")
);

type SessionCreatorSlot = NonNullable<ChatPanelProps["sessionCreatorSlot"]>;
type SessionCreatorSlotProps = React.ComponentProps<SessionCreatorSlot>;

interface EmbeddedAgentComposerOptions {
  launchpadIntent?: SessionCreatorSlotProps["launchpadIntent"];
  onSessionStart: NonNullable<SessionCreatorSlotProps["onSessionStart"]>;
  resolveWorkItemContext?: SessionCreatorSlotProps["resolveWorkItemContext"];
  workItemContext?: SessionCreatorSlotProps["workItemContext"];
}

interface WorkspaceScopedCreateContext {
  workspaceName: string | undefined;
  workspacePath: string | null;
}

function WorkspaceScopedContent({
  children,
}: {
  children: (context: WorkspaceScopedCreateContext) => React.ReactNode;
}): React.ReactNode {
  const workspaceRoot = useAtomValue(primaryWorkspaceRootAtom);
  const workspacePath = workspaceRoot?.path ?? null;
  const workspaceName = workspaceRoot?.name ?? undefined;

  return <>{children({ workspaceName, workspacePath })}</>;
}

interface ChatPanelEmptyContentProps {
  createProjectContext: ChatPanelCreateProjectContext | null;
  createTarget: ChatPanelCreateTarget;
  createTargetOptions: SelectOption[];
  creatorClassName: string;
  showStartPage: boolean;
  creatorVariant: "default" | "fullScreen";
  defaultAiWorkItemExecutionTarget: DefaultAiWorkItemExecutionTarget | null;
  handleAiWorkItemSessionStart: NonNullable<
    React.ComponentProps<SessionCreatorSlot>["onSessionStart"]
  >;
  handleCancelWorkItemCreate: () => void;
  handleChatPanelProjectCreated: (result?: CreatedProjectResult) => void;
  handleChatPanelWorkItemCreated: (result?: CreatedWorkItemResult) => void;
  handleOpenCliTerminal: NonNullable<
    React.ComponentProps<SessionCreatorSlot>["onOpenCliTerminal"]
  >;
  handleRegionNoticeChange: (notice: ChatPanelRegionNotice | null) => void;
  handleStartPageAddApiKey: () => void;
  handleCreateTargetChange: (target: string) => void;
  handleStartPageInstallLatestUpdate: () => void;
  handleStartPageShowRuntime: () => void;
  handleStartPageSessionStart: (info: SessionLaunchSuccessInfo) => void;
  handleProjectAgentCreatorToggle: (enabled: boolean) => void;
  handleWorkItemAgentCreatorToggle: (enabled: boolean) => void;
  resolveAiWorkItemContext: NonNullable<
    React.ComponentProps<SessionCreatorSlot>["resolveWorkItemContext"]
  >;
  SessionCreatorSlot?: ChatPanelProps["sessionCreatorSlot"];
  setWorkItemCreateDraft: (draft: WorkItemDraft | null) => void;
  showProjectAgentCreator: boolean;
  showWorkItemAgentCreator: boolean;
  t: TFunction<["sessions", "common", "projects", "navigation"]>;
}

export function ChatPanelEmptyContent({
  createProjectContext,
  createTarget,
  createTargetOptions,
  creatorClassName,
  showStartPage,
  creatorVariant,
  defaultAiWorkItemExecutionTarget,
  handleAiWorkItemSessionStart,
  handleCancelWorkItemCreate,
  handleChatPanelProjectCreated,
  handleChatPanelWorkItemCreated,
  handleOpenCliTerminal,
  handleRegionNoticeChange,
  handleStartPageAddApiKey,
  handleCreateTargetChange,
  handleStartPageInstallLatestUpdate,
  handleStartPageShowRuntime,
  handleStartPageSessionStart,
  handleProjectAgentCreatorToggle,
  handleWorkItemAgentCreatorToggle,
  resolveAiWorkItemContext,
  SessionCreatorSlot,
  setWorkItemCreateDraft,
  showProjectAgentCreator,
  showWorkItemAgentCreator,
  t,
}: ChatPanelEmptyContentProps): React.ReactNode {
  const projectDrafts = useAtomValue(projectDraftsAtom);
  const projectDraftOrgId = projectDrafts.get(PROJECT_CREATOR_DRAFT_ID)?.orgId;
  // Create-Project-with-AI lands the user IN the launched session (same
  // rationale as the AI work-item flow): a background launch that resets
  // to a blank creator with a toast minutes later reads as "nothing
  // happened".
  const openOrFocusSessionTab = useSetAtom(
    openOrFocusSessionInChatPanelTabAtom
  );
  const handleProjectCreatorSessionStart = useCallback(
    (info: SessionLaunchSuccessInfo) => {
      openOrFocusSessionTab({ sessionId: info.sessionId });
    },
    [openOrFocusSessionTab]
  );
  const createEmbeddedAgentComposer = SessionCreatorSlot
    ? ({
        launchpadIntent,
        onSessionStart,
        resolveWorkItemContext,
        workItemContext,
      }: EmbeddedAgentComposerOptions) =>
        function renderEmbeddedComposer(
          composerHeaderContent: React.ReactNode,
          pinnedActionsContent: React.ReactNode
        ) {
          return (
            <SessionCreatorSlot
              className="h-full min-h-0 flex-1"
              variant={creatorVariant}
              layout="launchpad"
              launchpadIntent={launchpadIntent}
              composerHeaderContent={composerHeaderContent}
              pinnedActionsContent={pinnedActionsContent}
              hidePresenceButton
              hideWorkItemAttachmentControl
              includeHumanSession={false}
              launchMode={SESSION_CREATOR_LAUNCH_MODE.START_BACKGROUND}
              onOpenCliTerminal={handleOpenCliTerminal}
              onRegionNoticeChange={handleRegionNoticeChange}
              onSessionStart={onSessionStart}
              resolveWorkItemContext={resolveWorkItemContext}
              workItemContext={workItemContext}
            />
          );
        }
    : undefined;
  const renderWorkItemCreator = (
    manualMiddleContent?: React.ReactNode,
    creatorModeControl?: React.ReactNode
  ) => {
    return (
      <WorkspaceScopedContent>
        {({ workspacePath }) => {
          return (
            <div
              className={`flex w-full min-w-0 overflow-hidden ${creatorClassName}`}
            >
              <Suspense fallback={null}>
                <CreateWorkItemView
                  orgId={createProjectContext?.orgId}
                  repoPath={workspacePath}
                  onCancel={handleCancelWorkItemCreate}
                  onSetUnsaved={() => undefined}
                  onWorkItemCreated={handleChatPanelWorkItemCreated}
                  onDraftChange={setWorkItemCreateDraft}
                  showCloseAction={false}
                  propertiesOpen={false}
                  showPropertiesAction={false}
                  aiGenerateMode={showWorkItemAgentCreator}
                  onAiGenerateModeChange={handleWorkItemAgentCreatorToggle}
                  showAiModePanel={false}
                  showFooter
                  chatPanelFooter
                  middleContent={manualMiddleContent}
                  creatorModeControl={creatorModeControl}
                  renderAgentComposer={createEmbeddedAgentComposer?.({
                    // A work item is written down, not built.
                    launchpadIntent: "plan",
                    onSessionStart: handleAiWorkItemSessionStart,
                    resolveWorkItemContext: resolveAiWorkItemContext,
                  })}
                  defaultAiExecutionTarget={defaultAiWorkItemExecutionTarget}
                />
              </Suspense>
            </div>
          );
        }}
      </WorkspaceScopedContent>
    );
  };

  const handleExitMultiRunner = useCallback(() => {
    handleCreateTargetChange(CHAT_PANEL_CREATE_TARGET.AGENT_SESSION);
  }, [handleCreateTargetChange]);

  const renderSessionLauncher = (
    className: string,
    layout: "default" | "launchpad" = "default",
    heroFooterSlot?: React.ReactNode,
    multiRunnerLauncher = false,
    hideWorkItemAttachmentControl = false
  ) =>
    SessionCreatorSlot ? (
      <SessionCreatorSlot
        className={className}
        variant={creatorVariant}
        layout={layout}
        heroFooterSlot={heroFooterSlot}
        hidePresenceButton
        hideWorkItemAttachmentControl={hideWorkItemAttachmentControl}
        // Only the Parallel-run create target fans out. Every other launcher
        // — Session, work item, project — starts one agent.
        multiRunnerLauncher={multiRunnerLauncher}
        onExitMultiRunner={handleExitMultiRunner}
        onOpenCliTerminal={handleOpenCliTerminal}
        onRegionNoticeChange={handleRegionNoticeChange}
        onSessionStart={handleStartPageSessionStart}
      />
    ) : null;

  const renderProjectCreator = (
    manualMiddleContent?: React.ReactNode,
    creatorModeControl?: React.ReactNode
  ) => {
    return (
      <WorkspaceScopedContent>
        {({ workspaceName, workspacePath }) => (
          <div
            className={`flex w-full min-w-0 overflow-hidden ${creatorClassName}`}
          >
            <Suspense fallback={null}>
              <CreateProjectView
                tabId={PROJECT_CREATOR_DRAFT_ID}
                repoPath={workspacePath ?? undefined}
                repoName={workspaceName}
                scopeBreadcrumbLabel={
                  createProjectContext?.scopeBreadcrumbLabel
                }
                orgId={createProjectContext?.orgId}
                onSetUnsaved={() => undefined}
                onProjectCreated={handleChatPanelProjectCreated}
                aiGenerateMode={showProjectAgentCreator}
                middleContent={manualMiddleContent}
                creatorModeControl={creatorModeControl}
                renderAgentComposer={createEmbeddedAgentComposer?.({
                  onSessionStart: handleProjectCreatorSessionStart,
                  workItemContext: {
                    orgId:
                      projectDraftOrgId ??
                      createProjectContext?.orgId ??
                      STORY_PERSONAL_ORG_FILTER_ID,
                    // The whole flow is "create a project via org2-pm" —
                    // without a workItemId the resolver would default to build
                    // and org2-pm would refuse project.mutate (§5.2). The
                    // exec-mode pin keeps run_shell available: read-only
                    // modes deny the shell the CLI rides on.
                    productMode: PRODUCT_MODE_PROJECT,
                    agentExecMode: "build",
                  },
                })}
              />
            </Suspense>
          </div>
        )}
      </WorkspaceScopedContent>
    );
  };

  if (showStartPage) {
    const moreCreateTarget =
      createTarget === CHAT_PANEL_CREATE_TARGET.PROJECT ||
      createTarget === CHAT_PANEL_CREATE_TARGET.PARALLEL_RUN
        ? createTarget
        : CHAT_PANEL_CREATE_TARGET.PROJECT;
    const moreLauncher = (
      manualMiddleContent: React.ReactNode,
      creatorModeControl?: React.ReactNode
    ) =>
      moreCreateTarget === CHAT_PANEL_CREATE_TARGET.PROJECT
        ? renderProjectCreator(manualMiddleContent, creatorModeControl)
        : renderSessionLauncher("h-full", "launchpad", undefined, true);

    return (
      <ChatPanelStartPage
        agentLauncher={
          SessionCreatorSlot
            ? ({
                createTarget: agentCreateTarget,
                heroFooterSlot,
                launchpadActionsVisible,
                workItemModeControl,
              }) => (
                <StartPageAgentComposer
                  createTarget={agentCreateTarget}
                  creatorModeControl={workItemModeControl}
                  creatorVariant={creatorVariant}
                  defaultAiWorkItemExecutionTarget={
                    defaultAiWorkItemExecutionTarget
                  }
                  handleAiWorkItemSessionStart={handleAiWorkItemSessionStart}
                  handleOpenCliTerminal={handleOpenCliTerminal}
                  handleRegionNoticeChange={handleRegionNoticeChange}
                  handleStartPageSessionStart={handleStartPageSessionStart}
                  heroFooterSlot={heroFooterSlot}
                  launchpadActionsVisible={launchpadActionsVisible}
                  onDraftChange={setWorkItemCreateDraft}
                  orgId={createProjectContext?.orgId}
                  resolveAiWorkItemContext={resolveAiWorkItemContext}
                  SessionCreatorSlot={SessionCreatorSlot}
                />
              )
            : undefined
        }
        className={creatorClassName}
        createTarget={createTarget}
        createTargetOptions={createTargetOptions}
        onAddApiKey={handleStartPageAddApiKey}
        onCreateTarget={handleCreateTargetChange}
        onInstallLatestUpdate={handleStartPageInstallLatestUpdate}
        onShowRuntime={handleStartPageShowRuntime}
        onProjectAgentModeChange={handleProjectAgentCreatorToggle}
        onWorkItemAgentModeChange={handleWorkItemAgentCreatorToggle}
        moreLauncher={moreLauncher}
        t={t}
        projectAgentMode={showProjectAgentCreator}
        workItemAgentMode={showWorkItemAgentCreator}
        manualWorkItemLauncher={(manualMiddleContent, creatorModeControl) =>
          renderWorkItemCreator(manualMiddleContent, creatorModeControl)
        }
      />
    );
  }

  if (createTarget === CHAT_PANEL_CREATE_TARGET.PROJECT) {
    return renderProjectCreator();
  }

  if (createTarget === CHAT_PANEL_CREATE_TARGET.WORK_ITEM) {
    return renderWorkItemCreator();
  }

  if (createTarget === CHAT_PANEL_CREATE_TARGET.PARALLEL_RUN) {
    return renderSessionLauncher(
      creatorClassName,
      "launchpad",
      undefined,
      true
    );
  }

  return null;
}

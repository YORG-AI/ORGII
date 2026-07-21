import type { TFunction } from "i18next";
import { useAtomValue } from "jotai";
import React, { Suspense } from "react";

import type { SelectOption } from "@src/components/Select";
import type { SessionLaunchSuccessInfo } from "@src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/types";
import { SESSION_CREATOR_LAUNCH_MODE } from "@src/features/SessionCreator/types";
import type { CreatedOrgResult } from "@src/features/TeamCollaboration/components/CreateCollabOrgView";
import type { CreatedWorkItemResult } from "@src/modules/ProjectManager/WorkItems/components/CreateWorkItemView";
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
import type { ChatPanelProps, ChatPanelRegionNotice } from "./types";

const CreateCollabOrgView = React.lazy(
  () => import("@src/features/TeamCollaboration/components/CreateCollabOrgView")
);
const CreateProjectView = React.lazy(
  () =>
    import("@src/modules/ProjectManager/Projects/components/CreateProjectView")
);
const GitHubIssuesImportWizard = React.lazy(
  () =>
    import("@src/modules/ProjectManager/Projects/components/GitHubIssuesImportWizard")
);
const CreateWorkItemView = React.lazy(
  () =>
    import("@src/modules/ProjectManager/WorkItems/components/CreateWorkItemView")
);
const BenchmarkRunBuilder = React.lazy(() =>
  import("./panels/BenchmarkRunBuilder").then((module) => ({
    default: module.BenchmarkRunBuilder,
  }))
);

type SessionCreatorSlot = NonNullable<ChatPanelProps["sessionCreatorSlot"]>;

interface DefaultAiWorkItemAssignee {
  id: string;
  name: string;
  type: "agent" | "org";
  agentDefinitionId?: string;
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
  defaultAiWorkItemAssignee: DefaultAiWorkItemAssignee | null;
  handleAiWorkItemSessionStart: NonNullable<
    React.ComponentProps<SessionCreatorSlot>["onSessionStart"]
  >;
  handleCancelWorkItemCreate: () => void;
  handleCancelCollabOrgCreate: () => void;
  handleCancelProjectCreate: () => void;
  handleChatPanelProjectCreated: (options?: { keepOpen?: boolean }) => void;
  handleChatPanelCollabOrgCreated: (result: CreatedOrgResult) => void;
  handleChatPanelWorkItemCreated: (result?: CreatedWorkItemResult) => void;
  handleOpenCliTerminal: NonNullable<
    React.ComponentProps<SessionCreatorSlot>["onOpenCliTerminal"]
  >;
  handleRegionNoticeChange: (notice: ChatPanelRegionNotice | null) => void;
  handleStartPageAddApiKey: () => void;
  handleCreateTargetChange: (target: ChatPanelCreateTarget) => void;
  handleStartPageInstallLatestUpdate: () => void;
  handleStartPageSessionStart: (info: SessionLaunchSuccessInfo) => void;
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
  defaultAiWorkItemAssignee,
  handleAiWorkItemSessionStart,
  handleCancelWorkItemCreate,
  handleCancelCollabOrgCreate,
  handleCancelProjectCreate,
  handleChatPanelProjectCreated,
  handleChatPanelCollabOrgCreated,
  handleChatPanelWorkItemCreated,
  handleOpenCliTerminal,
  handleRegionNoticeChange,
  handleStartPageAddApiKey,
  handleCreateTargetChange,
  handleStartPageInstallLatestUpdate,
  handleStartPageSessionStart,
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
  const renderWorkItemCreator = (showInlineAiModePanel: boolean) => {
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
                  scopeBreadcrumbLabel={
                    createProjectContext?.scopeBreadcrumbLabel
                  }
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
                  centerLauncherContent={showInlineAiModePanel}
                  showFooter
                  chatPanelFooter
                  renderAgentComposer={
                    SessionCreatorSlot
                      ? (headerContent) => (
                          <SessionCreatorSlot
                            className={
                              showInlineAiModePanel
                                ? "shrink-0"
                                : "min-h-0 flex-1"
                            }
                            variant={creatorVariant}
                            centerFullScreenContent
                            composerHeaderContent={headerContent}
                            innerClassName={
                              showInlineAiModePanel ? "pb-2 pt-1" : undefined
                            }
                            hidePresenceButton
                            launchMode={
                              SESSION_CREATOR_LAUNCH_MODE.START_BACKGROUND
                            }
                            onOpenCliTerminal={handleOpenCliTerminal}
                            onRegionNoticeChange={handleRegionNoticeChange}
                            onSessionStart={handleAiWorkItemSessionStart}
                            resolveWorkItemContext={resolveAiWorkItemContext}
                          />
                        )
                      : undefined
                  }
                  defaultAiAssignee={defaultAiWorkItemAssignee}
                />
              </Suspense>
            </div>
          );
        }}
      </WorkspaceScopedContent>
    );
  };

  const renderSessionLauncher = (className: string) =>
    SessionCreatorSlot ? (
      <SessionCreatorSlot
        className={className}
        variant={creatorVariant}
        innerClassName="pb-2 pt-1"
        hidePresenceButton
        onOpenCliTerminal={handleOpenCliTerminal}
        onRegionNoticeChange={handleRegionNoticeChange}
        onSessionStart={handleStartPageSessionStart}
      />
    ) : null;

  const renderProjectCreator = () => {
    const sessionCreatorContent =
      showProjectAgentCreator && SessionCreatorSlot ? (
        <SessionCreatorSlot
          className="min-h-0 flex-1"
          variant={creatorVariant}
          centerFullScreenContent
          hidePresenceButton
          launchMode={SESSION_CREATOR_LAUNCH_MODE.START_BACKGROUND}
          onOpenCliTerminal={handleOpenCliTerminal}
          onRegionNoticeChange={handleRegionNoticeChange}
          workItemContext={{
            orgId:
              projectDraftOrgId ??
              createProjectContext?.orgId ??
              STORY_PERSONAL_ORG_FILTER_ID,
          }}
        />
      ) : null;

    return (
      <WorkspaceScopedContent>
        {({ workspaceName, workspacePath }) => (
          <div
            className={`flex w-full min-w-0 flex-col overflow-hidden ${creatorClassName}`}
          >
            <div className="shrink-0 overflow-hidden">
              <Suspense fallback={null}>
                <CreateProjectView
                  tabId={PROJECT_CREATOR_DRAFT_ID}
                  repoPath={workspacePath ?? undefined}
                  repoName={workspaceName}
                  scopeBreadcrumbLabel={
                    createProjectContext?.scopeBreadcrumbLabel ??
                    t("projects:orgs.personalOrg")
                  }
                  orgId={
                    createProjectContext?.orgId ?? STORY_PERSONAL_ORG_FILTER_ID
                  }
                  onSetUnsaved={() => undefined}
                  onProjectCreated={handleChatPanelProjectCreated}
                  aiGenerateMode={showProjectAgentCreator}
                />
              </Suspense>
            </div>
            {sessionCreatorContent ? (
              <div className="min-h-0 flex-1 overflow-hidden pt-6">
                {sessionCreatorContent}
              </div>
            ) : null}
          </div>
        )}
      </WorkspaceScopedContent>
    );
  };

  const renderGithubIssuesCreator = () => (
    <WorkspaceScopedContent>
      {({ workspaceName, workspacePath }) => (
        <div
          className={`flex w-full min-w-0 overflow-hidden ${creatorClassName}`}
        >
          <Suspense fallback={null}>
            <GitHubIssuesImportWizard
              repoPath={workspacePath}
              repoName={workspaceName}
              orgId={
                createProjectContext?.orgId ?? STORY_PERSONAL_ORG_FILTER_ID
              }
              onCancel={handleCancelProjectCreate}
              onProjectCreated={handleChatPanelProjectCreated}
            />
          </Suspense>
        </div>
      )}
    </WorkspaceScopedContent>
  );

  const renderCollabOrgCreator = () => (
    <div className={`flex w-full min-w-0 overflow-hidden ${creatorClassName}`}>
      <Suspense fallback={null}>
        <CreateCollabOrgView
          onCancel={handleCancelCollabOrgCreate}
          onCreated={handleChatPanelCollabOrgCreated}
        />
      </Suspense>
    </div>
  );

  if (showStartPage) {
    const sessionLauncher = renderSessionLauncher("shrink-0");
    const moreCreateTarget =
      createTarget === CHAT_PANEL_CREATE_TARGET.PROJECT ||
      createTarget === CHAT_PANEL_CREATE_TARGET.GITHUB_ISSUES_PROJECT ||
      createTarget === CHAT_PANEL_CREATE_TARGET.MANAGE_AGENTS ||
      createTarget === CHAT_PANEL_CREATE_TARGET.COLLAB_ORG
        ? createTarget
        : CHAT_PANEL_CREATE_TARGET.PROJECT;
    const moreLauncher =
      moreCreateTarget === CHAT_PANEL_CREATE_TARGET.PROJECT
        ? renderProjectCreator()
        : moreCreateTarget === CHAT_PANEL_CREATE_TARGET.GITHUB_ISSUES_PROJECT
          ? renderGithubIssuesCreator()
          : moreCreateTarget === CHAT_PANEL_CREATE_TARGET.COLLAB_ORG
            ? renderCollabOrgCreator()
            : renderSessionLauncher("min-h-0 flex-1");

    return (
      <ChatPanelStartPage
        className={creatorClassName}
        createTarget={createTarget}
        createTargetOptions={createTargetOptions}
        onAddApiKey={handleStartPageAddApiKey}
        onCreateTarget={handleCreateTargetChange}
        onInstallLatestUpdate={handleStartPageInstallLatestUpdate}
        onWorkItemAgentModeChange={handleWorkItemAgentCreatorToggle}
        moreLauncher={moreLauncher}
        sessionLauncher={sessionLauncher}
        t={t}
        workItemAgentMode={showWorkItemAgentCreator}
        workItemLauncher={renderWorkItemCreator(true)}
      />
    );
  }

  if (createTarget === CHAT_PANEL_CREATE_TARGET.PROJECT) {
    return renderProjectCreator();
  }

  if (createTarget === CHAT_PANEL_CREATE_TARGET.GITHUB_ISSUES_PROJECT) {
    return renderGithubIssuesCreator();
  }

  if (createTarget === CHAT_PANEL_CREATE_TARGET.WORK_ITEM) {
    return renderWorkItemCreator(false);
  }

  if (createTarget === CHAT_PANEL_CREATE_TARGET.COLLAB_ORG) {
    return renderCollabOrgCreator();
  }

  if (createTarget === CHAT_PANEL_CREATE_TARGET.BENCHMARK) {
    return (
      <Suspense fallback={null}>
        <BenchmarkRunBuilder className={creatorClassName} />
      </Suspense>
    );
  }

  return null;
}

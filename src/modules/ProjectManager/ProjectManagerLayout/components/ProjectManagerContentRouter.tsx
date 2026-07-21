import React, { Suspense, memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { NoTabsPlaceholder } from "@src/modules/WorkStation/shared";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import {
  PROJECT_DETAIL_SURFACE_VIEW,
  PROJECT_LINEAR_SURFACE_VIEW,
  PROJECT_ORG_SURFACE_VIEW,
  STORY_ORG_SCOPE,
  getProjectWorkItemsTabChrome,
  getWorkItemDetailTabChrome,
  normalizeProjectDetailSurfaceView,
  normalizeProjectLinearSurfaceView,
  normalizeProjectOrgSurfaceView,
} from "@src/store/workstation/tabs";
import type {
  ProjectDetailSurfaceView,
  ProjectLinearSurfaceView,
  ProjectOrgScope,
} from "@src/store/workstation/tabs";
import type { WorkStationTab } from "@src/store/workstation/tabs";

import LinearProjectsPage from "../../LinearProjects";
import type { ProjectManagerContentRouterProps } from "../types";
import { ProjectLinearSurfacePillSwitch } from "./ProjectLinearSurfacePillSwitch";
import { ProjectWorkItemsTabContent } from "./ProjectWorkItemsTabContent";
import { RepoSettingsTabContent } from "./RepoSettingsTabContent";
import {
  getProjectManagerBreadcrumbSegments,
  getTabDataString,
} from "./projectManagerRouterUtils";

const WorkItemsPage = React.lazy(() => import("../../WorkItems"));
const ProjectsPage = React.lazy(() => import("../../Projects"));
const WorkItemDetailPage = React.lazy(
  () => import("../../WorkItems/components/WorkItemDetailPage")
);
const ProjectGitSyncReviewContent = React.lazy(
  () => import("./ProjectGitSyncReviewContent")
);
const ProjectOrgHubContent = React.lazy(() => import("./ProjectOrgHubContent"));
const GitCommitDetailContent = React.lazy(
  () =>
    import("@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/GitCommitDetailContent")
);
const ChatView = React.lazy(() => import("@src/engines/ChatPanel/ChatView"));

export const STORY_MANAGER_SUSPENSE_LOADING_FALLBACK = (
  <Placeholder variant="loading" placement="detail-panel" fillParentHeight />
);

export function ProjectManagerContentRouter({
  repoPath,
  tabs,
  activeTab,
  projectQuickActions,
  onSelectProject,
  onCreateProject,
  onCreateWorkItem,
  onOpenLinearProjects,
  onOpenRepoSettings,
  onExpandWorkItemToTab,
  onOpenChatSession,
  onCloseTab,
  onUpdateTabData,
  onUpdateTabMeta,
  onSetTabUnsaved,
  onEmbeddedWorkItemDetailStateChange,
  onProjectListRefreshRequested,
}: ProjectManagerContentRouterProps) {
  const { t } = useTranslation("projects");
  const hasNoTabs = tabs.length === 0;
  const persistentWorkItemTabs = useMemo(
    () =>
      tabs.filter(
        (tab) =>
          tab.type === "project-workitems" ||
          tab.type === "project-linear-projects" ||
          tab.type === "project-linear-work-items"
      ),
    [tabs]
  );

  const activeTabBreadcrumbSegments = useMemo(
    () => getProjectManagerBreadcrumbSegments(activeTab, t),
    [activeTab, t]
  );

  const nonWorkItemsContent = renderNonWorkItemsContent({
    repoPath,
    activeTab,
    breadcrumbSegments: activeTabBreadcrumbSegments,
    hasNoTabs,
    projectQuickActions,
    onSelectProject,
    onCreateProject,
    onCreateWorkItem,
    onOpenLinearProjects,
    onExpandWorkItemToTab,
    onOpenChatSession,
    onCloseTab,
    onUpdateTabData,
    onUpdateTabMeta,
  });

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="project-manager-content-router"
      data-active-tab-id={activeTab?.id ?? ""}
      data-active-tab-type={activeTab?.type ?? ""}
    >
      {nonWorkItemsContent && (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
          {nonWorkItemsContent}
        </div>
      )}

      {persistentWorkItemTabs.map((tab) => {
        const isActiveTab = activeTab?.id === tab.id;
        const projectView =
          tab.type === "project-workitems"
            ? normalizeProjectDetailSurfaceView(tab.data.projectView)
            : PROJECT_DETAIL_SURFACE_VIEW.WORK_ITEMS;
        return (
          <div
            key={tab.id}
            className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
            style={{ display: isActiveTab ? undefined : "none" }}
          >
            <Suspense fallback={STORY_MANAGER_SUSPENSE_LOADING_FALLBACK}>
              {tab.type === "project-workitems" ? (
                <WorkItemsPage
                  projectId={tab.data.projectId as string}
                  projectName={tab.data.projectName as string}
                  cachedProjectSlug={tab.data.projectSlug as string | undefined}
                  repoPath={repoPath}
                  projectView={projectView}
                  onProjectViewChange={(
                    nextProjectView: ProjectDetailSurfaceView
                  ) => {
                    onUpdateTabData(tab.id, { projectView: nextProjectView });
                  }}
                  breadcrumbSegments={getProjectManagerBreadcrumbSegments(
                    tab,
                    t
                  )}
                  workStationTabId={tab.id}
                  isActive={isActiveTab}
                  onProjectSlugResolved={(slug) => {
                    onUpdateTabData(tab.id, { projectSlug: slug });
                  }}
                  onProjectNameUpdated={(projectName) => {
                    onUpdateTabData(tab.id, { projectName });
                    onUpdateTabMeta(
                      tab.id,
                      getProjectWorkItemsTabChrome(projectName)
                    );
                  }}
                  onCreateProject={onCreateProject}
                  onEmbeddedWorkItemDetailStateChange={(tabId, state) =>
                    onEmbeddedWorkItemDetailStateChange(
                      tabId,
                      state,
                      tab.data.projectName as string
                    )
                  }
                  onEmbeddedWorkItemNameUpdated={(workItemName) => {
                    onUpdateTabMeta(
                      tab.id,
                      getWorkItemDetailTabChrome(workItemName)
                    );
                  }}
                  onCreateWorkItem={onCreateWorkItem}
                  onProjectDeleted={() => {
                    onCloseTab(tab.id);
                    onProjectListRefreshRequested();
                  }}
                  onSetUnsaved={(unsaved) => onSetTabUnsaved(tab.id, unsaved)}
                  onOpenRepoSettings={() => onOpenRepoSettings("members")}
                  onOpenChatSession={onOpenChatSession}
                  onExpandWorkItemToTab={(
                    workItemId,
                    workItemName,
                    pendingUpdates
                  ) =>
                    onExpandWorkItemToTab(
                      tab.data.projectId as string,
                      tab.data.projectName as string,
                      tab.data.projectSlug as string | undefined,
                      workItemId,
                      workItemName,
                      pendingUpdates
                    )
                  }
                />
              ) : (
                <LinearProjectsTabPane
                  tab={tab}
                  isActive={isActiveTab}
                  t={t}
                  repoPath={repoPath}
                  onCreateProject={onCreateProject}
                  onCreateWorkItem={onCreateWorkItem}
                  onUpdateTabData={onUpdateTabData}
                  onEmbeddedWorkItemDetailStateChange={
                    onEmbeddedWorkItemDetailStateChange
                  }
                />
              )}
            </Suspense>
          </div>
        );
      })}
    </div>
  );
}

interface LinearProjectsTabPaneProps {
  tab: WorkStationTab;
  isActive: boolean;
  t: (key: string) => string;
  repoPath: string;
  onCreateProject: ProjectManagerContentRouterProps["onCreateProject"];
  onCreateWorkItem: ProjectManagerContentRouterProps["onCreateWorkItem"];
  onUpdateTabData: ProjectManagerContentRouterProps["onUpdateTabData"];
  onEmbeddedWorkItemDetailStateChange: ProjectManagerContentRouterProps["onEmbeddedWorkItemDetailStateChange"];
}

const LinearProjectsTabPane: React.FC<LinearProjectsTabPaneProps> = memo(
  ({
    tab,
    isActive,
    t,
    repoPath,
    onCreateProject,
    onCreateWorkItem,
    onUpdateTabData,
    onEmbeddedWorkItemDetailStateChange,
  }) => {
    const linearSurface = normalizeProjectLinearSurfaceView(
      tab.data.linearSurface ??
        (tab.type === "project-linear-work-items"
          ? PROJECT_LINEAR_SURFACE_VIEW.WORK_ITEMS
          : PROJECT_LINEAR_SURFACE_VIEW.PROJECTS)
    );

    const breadcrumbSegments = useMemo(
      () => getProjectManagerBreadcrumbSegments(tab, t),
      [tab, t]
    );

    const handleLinearSurfaceChange = useCallback(
      (nextSurface: ProjectLinearSurfaceView) => {
        if (nextSurface === linearSurface) return;
        onUpdateTabData(tab.id, { linearSurface: nextSurface });
      },
      [linearSurface, onUpdateTabData, tab.id]
    );

    const linearSurfaceControls = useMemo(
      () => (
        <ProjectLinearSurfacePillSwitch
          linearSurface={linearSurface}
          onLinearSurfaceChange={handleLinearSurfaceChange}
        />
      ),
      [handleLinearSurfaceChange, linearSurface]
    );

    const handleOpenLinearProject = useCallback(
      (selection: {
        connectionId: string;
        projectId: string;
        projectName: string;
        teamId?: string;
        teamName?: string;
      }) => {
        onUpdateTabData(tab.id, selection);
      },
      [onUpdateTabData, tab.id]
    );

    const handleEmbeddedWorkItemDetailStateChange = useCallback(
      (
        tabId: string,
        state: Parameters<
          ProjectManagerContentRouterProps["onEmbeddedWorkItemDetailStateChange"]
        >[1]
      ) => {
        onEmbeddedWorkItemDetailStateChange(
          tabId,
          state,
          tab.data.projectName as string
        );
      },
      [onEmbeddedWorkItemDetailStateChange, tab.data.projectName]
    );

    return (
      <LinearProjectsPage
        surface={linearSurface}
        connectionId={tab.data.connectionId as string | undefined}
        projectId={tab.data.projectId as string | undefined}
        projectName={tab.data.projectName as string | undefined}
        teamId={tab.data.teamId as string | undefined}
        teamName={tab.data.teamName as string | undefined}
        breadcrumbSegments={breadcrumbSegments}
        linearSurfaceControls={linearSurfaceControls}
        workStationTabId={tab.id}
        repoPath={repoPath}
        onCreateProject={onCreateProject}
        onCreateWorkItem={onCreateWorkItem}
        onOpenLinearProject={handleOpenLinearProject}
        isActive={isActive}
        onEmbeddedWorkItemDetailStateChange={
          handleEmbeddedWorkItemDetailStateChange
        }
      />
    );
  }
);

LinearProjectsTabPane.displayName = "LinearProjectsTabPane";

interface RenderNonWorkItemsContentOptions {
  repoPath: string;
  activeTab: ProjectManagerContentRouterProps["activeTab"];
  breadcrumbSegments: readonly { label: string }[];
  hasNoTabs: boolean;
  projectQuickActions: ProjectManagerContentRouterProps["projectQuickActions"];
  onSelectProject: ProjectManagerContentRouterProps["onSelectProject"];
  onCreateProject: ProjectManagerContentRouterProps["onCreateProject"];
  onCreateWorkItem: ProjectManagerContentRouterProps["onCreateWorkItem"];
  onOpenLinearProjects: ProjectManagerContentRouterProps["onOpenLinearProjects"];
  onExpandWorkItemToTab: ProjectManagerContentRouterProps["onExpandWorkItemToTab"];
  onOpenChatSession: ProjectManagerContentRouterProps["onOpenChatSession"];
  onCloseTab: ProjectManagerContentRouterProps["onCloseTab"];
  onUpdateTabData: ProjectManagerContentRouterProps["onUpdateTabData"];
  onUpdateTabMeta: ProjectManagerContentRouterProps["onUpdateTabMeta"];
}

function renderNonWorkItemsContent({
  repoPath,
  activeTab,
  breadcrumbSegments,
  hasNoTabs,
  projectQuickActions,
  onSelectProject,
  onCreateProject,
  onCreateWorkItem,
  onOpenLinearProjects,
  onExpandWorkItemToTab,
  onOpenChatSession,
  onCloseTab,
  onUpdateTabData,
  onUpdateTabMeta,
}: RenderNonWorkItemsContentOptions): React.ReactNode {
  if (hasNoTabs || !activeTab) {
    return <NoTabsPlaceholder icon="project" actions={projectQuickActions} />;
  }

  if (
    activeTab.type === "project-workitems" ||
    activeTab.type === "project-linear-projects" ||
    activeTab.type === "project-linear-work-items"
  ) {
    return null;
  }

  const orgScope =
    (activeTab.data.orgScope as string | undefined) ?? STORY_ORG_SCOPE.ALL;
  const allowExternalSources = orgScope === STORY_ORG_SCOPE.ALL;
  const scopedOrgId =
    orgScope !== STORY_ORG_SCOPE.ALL
      ? getTabDataString(activeTab, "orgId")
      : undefined;

  switch (activeTab.type) {
    case "project-dashboard":
      return (
        <Suspense fallback={STORY_MANAGER_SUSPENSE_LOADING_FALLBACK}>
          <ProjectsPage
            breadcrumbSegments={breadcrumbSegments}
            orgId={scopedOrgId}
            onOpenProject={onSelectProject}
            onAddProject={onCreateProject}
            onOpenLinearProject={onOpenLinearProjects}
            allowExternalSources={allowExternalSources}
            publishToWorkstationHeader
            workStationTabId={activeTab.id}
          />
        </Suspense>
      );

    case "project-work-items":
      return (
        <Suspense fallback={STORY_MANAGER_SUSPENSE_LOADING_FALLBACK}>
          <ProjectWorkItemsTabContent
            breadcrumbSegments={breadcrumbSegments}
            orgId={scopedOrgId}
            onOpenWorkItem={onExpandWorkItemToTab}
            onOpenLinearProject={onOpenLinearProjects}
            allowExternalSources={allowExternalSources}
            onCreateProject={onCreateProject}
            onCreateWorkItem={() => onCreateWorkItem()}
            workStationTabId={activeTab.id}
          />
        </Suspense>
      );

    case "project-git-sync-review":
      return (
        <Suspense fallback={STORY_MANAGER_SUSPENSE_LOADING_FALLBACK}>
          <ProjectGitSyncReviewContent
            orgId={activeTab.data.orgId as string}
            orgName={activeTab.data.orgName as string | undefined}
          />
        </Suspense>
      );

    case "project-org":
    case "project-org-settings": {
      const orgId = getTabDataString(activeTab, "orgId");
      if (!orgId) return null;
      const orgScope =
        (activeTab.data.orgScope as ProjectOrgScope | undefined) ??
        STORY_ORG_SCOPE.PROJECT_ORG;
      const orgView =
        activeTab.type === "project-org-settings"
          ? PROJECT_ORG_SURFACE_VIEW.SETTINGS
          : normalizeProjectOrgSurfaceView(activeTab.data.orgView);

      return (
        <Suspense fallback={STORY_MANAGER_SUSPENSE_LOADING_FALLBACK}>
          <ProjectOrgHubContent
            orgId={orgId}
            orgScope={orgScope}
            orgView={orgView}
            breadcrumbSegments={breadcrumbSegments}
            workStationTabId={activeTab.id}
            onOrgViewChange={(view) => {
              onUpdateTabData(activeTab.id, { orgView: view });
            }}
            onSelectProject={onSelectProject}
            onCreateProject={onCreateProject}
            onCreateWorkItem={onCreateWorkItem}
            onExpandWorkItemToTab={onExpandWorkItemToTab}
            onOpenLinearProjects={onOpenLinearProjects}
          />
        </Suspense>
      );
    }

    case "project-settings":
      return (
        <Suspense fallback={STORY_MANAGER_SUSPENSE_LOADING_FALLBACK}>
          <RepoSettingsTabContent
            initialSection={activeTab.data.section as string}
          />
        </Suspense>
      );

    case "workItem-detail":
      return (
        <Suspense fallback={STORY_MANAGER_SUSPENSE_LOADING_FALLBACK}>
          <WorkItemDetailPage
            projectId={activeTab.data.projectId as string}
            projectName={activeTab.data.projectName as string}
            projectSlug={activeTab.data.projectSlug as string | undefined}
            workItemId={activeTab.data.workItemId as string}
            onClose={() => onCloseTab(activeTab.id)}
            onOpenChatSession={onOpenChatSession}
            pendingUpdates={
              activeTab.data.pendingUpdates as
                | Record<string, unknown>
                | undefined
            }
            publishHeaderToWorkstation
            onWorkItemNameUpdated={(workItemName) => {
              onUpdateTabData(activeTab.id, { workItemName });
              onUpdateTabMeta(
                activeTab.id,
                getWorkItemDetailTabChrome(workItemName)
              );
            }}
          />
        </Suspense>
      );

    case "chat-session": {
      const chatSessionId = String(activeTab.data.sessionId || "");
      if (!chatSessionId) return null;
      return (
        <Suspense fallback={STORY_MANAGER_SUSPENSE_LOADING_FALLBACK}>
          <div
            data-chat-panel
            className="flex h-full min-w-0 flex-1 flex-col overflow-hidden text-sm"
            style={{
              background:
                "linear-gradient(180deg, var(--color-bg-1) 0%, var(--color-fill-1) 100%)",
            }}
          >
            <ChatView sessionId={chatSessionId} secondary />
          </div>
        </Suspense>
      );
    }

    case "git-commit-detail": {
      const commitSha = String(activeTab.data.commitSha || "");
      const commitShortSha = String(activeTab.data.shortSha || "");
      const commitMessage = String(activeTab.data.commitMessage || "");

      return (
        <Suspense fallback={STORY_MANAGER_SUSPENSE_LOADING_FALLBACK}>
          <GitCommitDetailContent
            commitSha={commitSha}
            shortSha={commitShortSha}
            commitMessage={commitMessage}
            repoPath={repoPath}
            repoId={repoPath}
          />
        </Suspense>
      );
    }

    default:
      return <NoTabsPlaceholder icon="project" actions={projectQuickActions} />;
  }
}

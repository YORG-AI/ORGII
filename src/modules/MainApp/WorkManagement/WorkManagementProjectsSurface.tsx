import { useAtom, useSetAtom } from "jotai";
import React, {
  Suspense,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import { useWorkStationTabs } from "@src/hooks/tabHost/useWorkStationTabs";
import type { LinearProjectSelection } from "@src/modules/ProjectManager/Panels/ProjectManagerSidebar/content/WorkspaceTreeContent";
import type { ProjectWorkItemSelection } from "@src/modules/ProjectManager/ProjectManagerLayout/components/ProjectWorkItemsTabContent";
import type { ActiveRepoView } from "@src/modules/ProjectManager/ProjectManagerLayout/types";
import {
  openCreateTargetInChatPanelStartPageAtom,
  openWorkItemInChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { projectListRefreshAtom } from "@src/store/project/projectAtom";
import {
  CHAT_PANEL_CREATE_TARGET,
  activeStationChatVisibleAtom,
} from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import {
  STORY_ORG_SCOPE,
  WORK_MANAGEMENT_PROJECTS_VIEW,
  createWorkItemDetailTab,
  workManagementProjectsViewAtom,
} from "@src/store/workstation";
import type { WorkItem } from "@src/types/core/workItem";

import type { WorkManagementDetailHost } from "./workManagementDetailHost";

const LinearProjectsPage = React.lazy(
  () => import("@src/modules/ProjectManager/LinearProjects")
);
const ProjectWorkItemsTabContent = React.lazy(() =>
  import("@src/modules/ProjectManager/ProjectManagerLayout/components/ProjectWorkItemsTabContent").then(
    (module) => ({ default: module.ProjectWorkItemsTabContent })
  )
);
const RepoSettingsTabContent = React.lazy(() =>
  import("@src/modules/ProjectManager/ProjectManagerLayout/components/RepoSettingsTabContent").then(
    (module) => ({ default: module.RepoSettingsTabContent })
  )
);
const ProjectsPage = React.lazy(
  () => import("@src/modules/ProjectManager/Projects")
);
const WorkItemsPage = React.lazy(
  () => import("@src/modules/ProjectManager/WorkItems")
);
const WORK_MANAGEMENT_PROJECTS_LOADING_FALLBACK = (
  <Placeholder variant="loading" placement="detail-panel" fillParentHeight />
);

interface SelectedProjectView {
  kind: "project";
  projectId: string;
  projectName: string;
  projectSlug?: string;
}

interface RepoView {
  kind: "repo";
  view: Exclude<ActiveRepoView, null>;
  orgScope?: string;
  orgId?: string;
  orgName?: string;
  orgSyncProvider?: string | null;
  linearSelection?: LinearProjectSelection;
}

type ProjectsSurfaceView = SelectedProjectView | RepoView;

function isRepoView(view: ProjectsSurfaceView): view is RepoView {
  return view.kind === "repo";
}

const WorkManagementProjectsSurface: React.FC<{
  detailHost: WorkManagementDetailHost;
}> = memo(({ detailHost }) => {
  const { t } = useTranslation("projects");
  const [workManagementProjectsView, setWorkManagementProjectsView] = useAtom(
    workManagementProjectsViewAtom
  );
  const [view, setView] = useState<ProjectsSurfaceView>({
    kind: "repo",
    view: workManagementProjectsView,
    orgScope: STORY_ORG_SCOPE.ALL,
  });
  const [selectedProjectSlug, setSelectedProjectSlug] = useState<
    string | undefined
  >(undefined);
  const bumpProjectListRefresh = useSetAtom(projectListRefreshAtom);
  const { openTab } = useWorkStationTabs();
  const openWorkItemInChatPanel = useSetAtom(openWorkItemInChatPanelTabAtom);

  const setStationMode = useSetAtom(stationModeAtom);
  const setStationChatVisible = useSetAtom(activeStationChatVisibleAtom);
  const openCreateTargetInStartPage = useSetAtom(
    openCreateTargetInChatPanelStartPageAtom
  );

  const activeOrgScope =
    view.kind === "repo" ? (view.orgScope ?? STORY_ORG_SCOPE.ALL) : null;
  const scopedOrgId =
    activeOrgScope === STORY_ORG_SCOPE.ALL
      ? undefined
      : isRepoView(view)
        ? view.orgId
        : undefined;
  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setView((currentView) => {
        if (
          currentView.kind === "repo" &&
          currentView.view === workManagementProjectsView
        ) {
          return currentView;
        }
        return {
          kind: "repo",
          view: workManagementProjectsView,
          orgScope: STORY_ORG_SCOPE.ALL,
        };
      });
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [workManagementProjectsView]);

  const handleSelectProject = useCallback(
    (projectId: string, projectName: string, projectSlug?: string) => {
      setSelectedProjectSlug(projectSlug);
      setView({ kind: "project", projectId, projectName, projectSlug });
    },
    []
  );

  const handleOpenLinearProjects = useCallback(
    (selection?: LinearProjectSelection) => {
      setView({
        kind: "repo",
        view: "linear-projects",
        linearSelection: selection,
      });
    },
    []
  );

  const handleOpenLinearWorkItems = useCallback(
    (selection?: LinearProjectSelection) => {
      setView({
        kind: "repo",
        view: "linear-work-items",
        linearSelection: selection,
      });
    },
    []
  );

  const handleOpenSettings = useCallback(() => {
    setView({ kind: "repo", view: "settings" });
  }, []);

  const handleOpenProjects = useCallback(() => {
    setWorkManagementProjectsView(WORK_MANAGEMENT_PROJECTS_VIEW.PROJECTS);
    setView({
      kind: "repo",
      view: WORK_MANAGEMENT_PROJECTS_VIEW.PROJECTS,
      orgScope: STORY_ORG_SCOPE.ALL,
    });
  }, [setWorkManagementProjectsView]);

  const handleProjectDeleted = useCallback(() => {
    handleOpenProjects();
    bumpProjectListRefresh((previous) => previous + 1);
  }, [bumpProjectListRefresh, handleOpenProjects]);

  const handleCreateProject = useCallback(() => {
    openCreateTargetInStartPage({
      target: CHAT_PANEL_CREATE_TARGET.PROJECT,
    });
    setStationMode("my-station");
    setStationChatVisible("my-station", true);
  }, [openCreateTargetInStartPage, setStationChatVisible, setStationMode]);

  const handleCreateWorkItem = useCallback(() => {
    openCreateTargetInStartPage({
      target: CHAT_PANEL_CREATE_TARGET.WORK_ITEM,
    });
    setStationMode("my-station");
    setStationChatVisible("my-station", true);
  }, [openCreateTargetInStartPage, setStationChatVisible, setStationMode]);

  const handleOpenProjectWorkItem = useCallback(
    (
      project: SelectedProjectView,
      workItemId: string,
      workItemName: string,
      pendingUpdates?: Record<string, unknown>,
      workItemStatus?: string,
      workItem?: WorkItem
    ) => {
      const projectSlug = selectedProjectSlug ?? project.projectSlug;
      if (detailHost === "chat") {
        if (!workItem || !projectSlug) return;
        openWorkItemInChatPanel({
          workItem,
          shortId: workItem.shortId || workItemId,
          projectId: project.projectId,
          projectName: project.projectName,
          projectSlug,
        });
        return;
      }
      openTab(
        createWorkItemDetailTab(
          project.projectId,
          project.projectName,
          workItemId,
          workItemName,
          projectSlug,
          pendingUpdates,
          undefined,
          workItemStatus
        )
      );
    },
    [detailHost, openTab, openWorkItemInChatPanel, selectedProjectSlug]
  );

  const handleOpenAggregatedWorkItem = useCallback(
    (selection: ProjectWorkItemSelection) => {
      if (detailHost === "chat") {
        openWorkItemInChatPanel({
          workItem: selection.workItem,
          shortId: selection.shortId,
          orgId: selection.orgId,
          orgName: selection.orgName,
          projectId: selection.projectId ?? "",
          projectName:
            selection.projectName ??
            selection.orgName ??
            "Standalone Work Items",
          projectSlug: selection.projectSlug ?? "",
        });
        return;
      }
      openTab(
        createWorkItemDetailTab(
          selection.projectId,
          selection.projectName,
          selection.workItem.session_id,
          selection.workItem.name || t("common:placeholders.untitled"),
          selection.projectSlug,
          undefined,
          undefined,
          selection.workItem.workItemStatus ?? selection.workItem.status,
          selection.orgId
        )
      );
    },
    [detailHost, openTab, openWorkItemInChatPanel, t]
  );

  const content = useMemo(() => {
    if (view.kind === "project") {
      return (
        <WorkItemsPage
          breadcrumbSegments={[
            {
              label: t("workspace.projects"),
              onClick: handleOpenProjects,
            },
            { label: view.projectName },
          ]}
          projectId={view.projectId}
          projectName={view.projectName}
          cachedProjectSlug={selectedProjectSlug ?? view.projectSlug}
          isActive
          workStationTabId="work-management-projects"
          workstationHeaderHost="workManagement"
          onProjectSlugResolved={setSelectedProjectSlug}
          onOpenProjects={handleOpenProjects}
          onCreateProject={handleCreateProject}
          onCreateWorkItem={handleCreateWorkItem}
          onProjectDeleted={handleProjectDeleted}
          onOpenRepoSettings={handleOpenSettings}
          onExpandWorkItemToTab={(
            workItemId,
            workItemName,
            pendingUpdates,
            workItemStatus,
            workItem
          ) =>
            handleOpenProjectWorkItem(
              view,
              workItemId,
              workItemName,
              pendingUpdates,
              workItemStatus,
              workItem
            )
          }
        />
      );
    }

    switch (view.view) {
      case "projects":
        return (
          <ProjectsPage
            breadcrumbSegments={[]}
            onOpenProject={handleSelectProject}
            orgId={scopedOrgId}
            onAddProject={handleCreateProject}
            onOpenLinearProject={handleOpenLinearProjects}
            allowExternalSources={activeOrgScope === STORY_ORG_SCOPE.ALL}
            publishToWorkstationHeader
            workStationTabId="work-management-projects"
            workstationHeaderHost="workManagement"
          />
        );
      case "work-items":
        return (
          <ProjectWorkItemsTabContent
            breadcrumbSegments={[]}
            workStationTabId="work-management-projects"
            workstationHeaderHost="workManagement"
            orgId={scopedOrgId}
            onCreateProject={handleCreateProject}
            onCreateWorkItem={handleCreateWorkItem}
            onOpenLinearProject={handleOpenLinearProjects}
            allowExternalSources={activeOrgScope === STORY_ORG_SCOPE.ALL}
            onOpenWorkItem={handleOpenAggregatedWorkItem}
          />
        );
      case "linear-projects":
      case "linear-work-items":
        return (
          <LinearProjectsPage
            surface={
              view.view === "linear-work-items" ? "work-items" : "projects"
            }
            connectionId={view.linearSelection?.connectionId}
            projectId={view.linearSelection?.projectId}
            projectName={view.linearSelection?.projectName}
            teamId={view.linearSelection?.teamId}
            teamName={view.linearSelection?.teamName}
            workStationTabId="work-management-projects"
            workstationHeaderHost="workManagement"
            isActive
            onOpenLinearProject={(selection) => {
              if (view.view === "linear-work-items") {
                handleOpenLinearWorkItems(selection);
                return;
              }
              handleOpenLinearProjects(selection);
            }}
          />
        );
      case "settings":
        return <RepoSettingsTabContent />;
      default:
        return null;
    }
  }, [
    handleOpenLinearProjects,
    handleOpenLinearWorkItems,
    handleOpenSettings,
    handleOpenProjects,
    handleSelectProject,
    handleProjectDeleted,
    handleCreateProject,
    handleCreateWorkItem,
    handleOpenAggregatedWorkItem,
    handleOpenProjectWorkItem,
    selectedProjectSlug,
    activeOrgScope,
    scopedOrgId,
    t,
    view,
  ]);

  return (
    <div className="work-management-page flex h-full min-h-0 w-full flex-col overflow-hidden">
      <Suspense fallback={WORK_MANAGEMENT_PROJECTS_LOADING_FALLBACK}>
        {content}
      </Suspense>
    </div>
  );
});

WorkManagementProjectsSurface.displayName = "WorkManagementProjectsSurface";

export default WorkManagementProjectsSurface;

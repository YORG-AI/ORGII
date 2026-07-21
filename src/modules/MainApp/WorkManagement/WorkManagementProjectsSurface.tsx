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

import LinearProjectsPage from "@src/modules/ProjectManager/LinearProjects";
import type { LinearProjectSelection } from "@src/modules/ProjectManager/Panels/ProjectManagerSidebar/content/WorkspaceTreeContent";
import { STORY_MANAGER_SUSPENSE_LOADING_FALLBACK } from "@src/modules/ProjectManager/ProjectManagerLayout/components/ProjectManagerContentRouter";
import { ProjectWorkItemsTabContent } from "@src/modules/ProjectManager/ProjectManagerLayout/components/ProjectWorkItemsTabContent";
import { RepoSettingsTabContent } from "@src/modules/ProjectManager/ProjectManagerLayout/components/RepoSettingsTabContent";
import type { ActiveRepoView } from "@src/modules/ProjectManager/ProjectManagerLayout/types";
import ProjectsPage from "@src/modules/ProjectManager/Projects";
import WorkItemsPage from "@src/modules/ProjectManager/WorkItems";
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
  STORY_PERSONAL_ORG_FILTER_ID,
  WORK_MANAGEMENT_PROJECTS_VIEW,
  workManagementProjectsViewAtom,
} from "@src/store/workstation";

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

const WorkManagementProjectsSurface: React.FC = memo(() => {
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

  const setStationMode = useSetAtom(stationModeAtom);
  const setStationChatVisible = useSetAtom(activeStationChatVisibleAtom);
  const openWorkItemTab = useSetAtom(openWorkItemInChatPanelTabAtom);
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

  const handleOpenProjects = useCallback(() => {
    setWorkManagementProjectsView(WORK_MANAGEMENT_PROJECTS_VIEW.PROJECTS);
    setView({
      kind: "repo",
      view: WORK_MANAGEMENT_PROJECTS_VIEW.PROJECTS,
      orgScope: STORY_ORG_SCOPE.ALL,
    });
  }, [setWorkManagementProjectsView]);

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

  const handleProjectDeleted = useCallback(() => {
    setWorkManagementProjectsView(WORK_MANAGEMENT_PROJECTS_VIEW.PROJECTS);
    setView({ kind: "repo", view: WORK_MANAGEMENT_PROJECTS_VIEW.PROJECTS });
    bumpProjectListRefresh((previous) => previous + 1);
  }, [bumpProjectListRefresh, setWorkManagementProjectsView]);

  const handleCreateProject = useCallback(() => {
    openCreateTargetInStartPage({
      target: CHAT_PANEL_CREATE_TARGET.PROJECT,
      createProjectContext: {
        orgId: STORY_PERSONAL_ORG_FILTER_ID,
        scopeBreadcrumbLabel: t("orgs.personalOrg"),
      },
    });
    setStationMode("my-station");
    setStationChatVisible("my-station", true);
  }, [openCreateTargetInStartPage, setStationChatVisible, setStationMode, t]);

  const handleCreateWorkItem = useCallback(() => {
    openCreateTargetInStartPage({
      target: CHAT_PANEL_CREATE_TARGET.WORK_ITEM,
    });
    setStationMode("my-station");
    setStationChatVisible("my-station", true);
  }, [openCreateTargetInStartPage, setStationChatVisible, setStationMode]);

  const content = useMemo(() => {
    if (view.kind === "project") {
      return (
        <WorkItemsPage
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
        />
      );
    }

    switch (view.view) {
      case "projects":
        return (
          <ProjectsPage
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
            workStationTabId="work-management-projects"
            workstationHeaderHost="workManagement"
            orgId={scopedOrgId}
            onCreateProject={handleCreateProject}
            onCreateWorkItem={handleCreateWorkItem}
            onOpenLinearProject={handleOpenLinearProjects}
            allowExternalSources={activeOrgScope === STORY_ORG_SCOPE.ALL}
            onOpenWorkItem={(selection) => {
              openWorkItemTab({
                workItem: selection.workItem,
                shortId: selection.shortId,
                orgId: selection.orgId,
                orgName: selection.orgName,
                projectId: selection.projectId ?? "",
                projectName: selection.projectName ?? "",
                projectSlug: selection.projectSlug ?? "",
              });
              setStationMode("my-station");
              setStationChatVisible("my-station", true);
            }}
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
    openWorkItemTab,
    setStationChatVisible,
    setStationMode,
    selectedProjectSlug,
    activeOrgScope,
    scopedOrgId,
    view,
  ]);

  return (
    <div className="work-management-page flex h-full min-h-0 w-full flex-col overflow-hidden">
      <Suspense fallback={STORY_MANAGER_SUSPENSE_LOADING_FALLBACK}>
        {content}
      </Suspense>
    </div>
  );
});

WorkManagementProjectsSurface.displayName = "WorkManagementProjectsSurface";

export default WorkManagementProjectsSurface;

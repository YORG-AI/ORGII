import React, { Suspense, useMemo } from "react";

import { Placeholder } from "@src/components/Placeholder";
import {
  PROJECT_ORG_SURFACE_VIEW,
  type ProjectOrgScope,
  type ProjectOrgSurfaceView,
  STORY_ORG_SCOPE,
} from "@src/store/workstation/tabs";

import type { LinearProjectSelection } from "../../Panels/ProjectManagerSidebar/content/WorkspaceTreeContent";
import { useProjectOrgCatalogData } from "../hooks/useProjectOrgCatalogData";
import type { ExpandWorkItemToTabHandler } from "../types";
import { STORY_MANAGER_SUSPENSE_LOADING_FALLBACK } from "./ProjectManagerContentRouter";
import { ProjectOrgHubHeader } from "./ProjectOrgHubHeader";
import { ProjectOrgSettingsPane } from "./ProjectOrgSettingsPane";
import { ProjectOrgSurfacePillSwitch } from "./ProjectOrgSurfacePillSwitch";
import { ProjectWorkItemsTabContent } from "./ProjectWorkItemsTabContent";

const ProjectsPage = React.lazy(() => import("../../Projects"));

export interface ProjectOrgHubContentProps {
  orgId: string;
  orgScope: ProjectOrgScope;
  orgView: ProjectOrgSurfaceView;
  breadcrumbSegments?: readonly { label: string }[];
  workStationTabId?: string;
  renderSurfaceControlsInline?: boolean;
  onOrgViewChange: (view: ProjectOrgSurfaceView) => void;
  onSelectProject: (
    projectId: string,
    projectName: string,
    projectSlug?: string
  ) => void;
  onCreateProject: () => void;
  onCreateWorkItem: () => void;
  onExpandWorkItemToTab: ExpandWorkItemToTabHandler;
  onOpenLinearProjects?: (selection?: LinearProjectSelection) => void;
  onOrgDeleted?: (orgId: string) => void | Promise<void>;
}

export const ProjectOrgHubContent: React.FC<ProjectOrgHubContentProps> = ({
  orgId,
  orgScope,
  orgView,
  breadcrumbSegments,
  workStationTabId,
  renderSurfaceControlsInline = false,
  onOrgViewChange,
  onSelectProject,
  onCreateProject,
  onCreateWorkItem,
  onExpandWorkItemToTab,
  onOpenLinearProjects,
  onOrgDeleted,
}) => {
  const catalog = useProjectOrgCatalogData(orgId);

  const scopedOrgId = orgScope === STORY_ORG_SCOPE.ALL ? undefined : orgId;

  const resolvedBreadcrumbSegments = useMemo(
    () =>
      breadcrumbSegments?.length
        ? breadcrumbSegments
        : [{ label: catalog.org?.name ?? "—" }],
    [breadcrumbSegments, catalog.org?.name]
  );

  const orgSurfaceControls = useMemo(
    () => (
      <ProjectOrgSurfacePillSwitch
        orgView={orgView}
        onOrgViewChange={onOrgViewChange}
      />
    ),
    [orgView, onOrgViewChange]
  );

  const inlineOrgSurfaceControls = useMemo(
    () => (
      <ProjectOrgSurfacePillSwitch
        orgView={orgView}
        onOrgViewChange={onOrgViewChange}
      />
    ),
    [orgView, onOrgViewChange]
  );

  const shouldPublishWorkstationChrome = Boolean(workStationTabId);
  const publishesHubHeaderOnly =
    shouldPublishWorkstationChrome &&
    !renderSurfaceControlsInline &&
    orgView === PROJECT_ORG_SURFACE_VIEW.SETTINGS;
  const contentOrgSurfaceControls = renderSurfaceControlsInline
    ? undefined
    : orgSurfaceControls;

  const handleDeleteOrg = React.useCallback(async () => {
    await catalog.handleDeleteOrg();
    await onOrgDeleted?.(orgId);
  }, [catalog, onOrgDeleted, orgId]);

  const body = useMemo(() => {
    if (orgView === PROJECT_ORG_SURFACE_VIEW.PROJECTS) {
      return (
        <Suspense fallback={STORY_MANAGER_SUSPENSE_LOADING_FALLBACK}>
          <ProjectsPage
            breadcrumbSegments={resolvedBreadcrumbSegments}
            orgId={scopedOrgId}
            onOpenProject={onSelectProject}
            onAddProject={onCreateProject}
            onOpenLinearProject={onOpenLinearProjects}
            allowExternalSources={false}
            publishToWorkstationHeader={shouldPublishWorkstationChrome}
            workStationTabId={workStationTabId}
            orgSurfaceControls={contentOrgSurfaceControls}
          />
        </Suspense>
      );
    }

    if (orgView === PROJECT_ORG_SURFACE_VIEW.WORK_ITEMS) {
      return (
        <Suspense fallback={STORY_MANAGER_SUSPENSE_LOADING_FALLBACK}>
          <ProjectWorkItemsTabContent
            breadcrumbSegments={resolvedBreadcrumbSegments}
            orgId={scopedOrgId}
            onOpenWorkItem={(selection) =>
              onExpandWorkItemToTab(
                selection.projectId,
                selection.projectName,
                selection.projectSlug,
                selection.workItem.session_id,
                selection.workItem.name,
                undefined,
                selection.workItem.workItemStatus ?? selection.workItem.status
              )
            }
            onOpenLinearProject={onOpenLinearProjects}
            allowExternalSources={false}
            onCreateProject={onCreateProject}
            onCreateWorkItem={onCreateWorkItem}
            workStationTabId={workStationTabId}
            orgSurfaceControls={contentOrgSurfaceControls}
          />
        </Suspense>
      );
    }

    if (catalog.loading) {
      return <Placeholder variant="loading" fillParentHeight />;
    }

    if (catalog.loadError) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <div className="max-w-md rounded-lg border border-danger-6/30 bg-danger-2/20 px-4 py-3 text-sm text-danger-6">
            {catalog.loadError}
          </div>
        </div>
      );
    }

    if (orgView === PROJECT_ORG_SURFACE_VIEW.SETTINGS) {
      return (
        <ProjectOrgSettingsPane
          org={catalog.org}
          projectCount={catalog.projects.length}
          labels={catalog.labels}
          folderPath={catalog.folderPath}
          onFolderPathChange={catalog.setFolderPath}
          onConfigureGitFolder={catalog.handleConfigureGitFolder}
          onSyncGitFolder={catalog.handleSyncGitFolder}
          onUpdateLabels={catalog.handleUpdateLabels}
          onDeleteOrg={handleDeleteOrg}
        />
      );
    }

    return null;
  }, [
    catalog,
    onCreateProject,
    onCreateWorkItem,
    onExpandWorkItemToTab,
    onOpenLinearProjects,
    onSelectProject,
    contentOrgSurfaceControls,
    handleDeleteOrg,
    orgView,
    resolvedBreadcrumbSegments,
    scopedOrgId,
    shouldPublishWorkstationChrome,
    workStationTabId,
  ]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {publishesHubHeaderOnly && (
        <ProjectOrgHubHeader
          breadcrumbSegments={resolvedBreadcrumbSegments}
          orgView={orgView}
          onOrgViewChange={onOrgViewChange}
        />
      )}
      {renderSurfaceControlsInline ? (
        <div className="shrink-0 px-4 pb-4 pt-2">
          {inlineOrgSurfaceControls}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">{body}</div>
    </div>
  );
};

export default ProjectOrgHubContent;

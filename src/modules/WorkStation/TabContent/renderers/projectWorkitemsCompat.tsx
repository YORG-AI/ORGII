/**
 * Renderer wrapper for `project-workitems` (no-hyphen variant) tabs.
 *
 * Renders the project work-items surface (`WorkItemsPage`) through the unified
 * dispatcher, pulling action callbacks from the hoisted Project host context
 * and deriving breadcrumb / project view from tab data — mirroring how
 * `ProjectManagerContentRouter` mounts `WorkItemsPage` for `project-workitems`
 * tabs (part of the persistent keep-alive trio).
 *
 * TODO(phase-2): merge with `project-work-items` once the persistent tab cache
 * is fully owned by the dispatcher, then delete this file.
 */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { getProjectManagerBreadcrumbSegments } from "@src/modules/ProjectManager/ProjectManagerLayout/components/projectManagerRouterUtils";
import { useProjectHostContext } from "@src/modules/ProjectManager/ProjectManagerLayout/context/projectHostContext";
import WorkItemsPage from "@src/modules/ProjectManager/WorkItems";
import {
  getProjectWorkItemsTabChrome,
  normalizeProjectDetailSurfaceView,
} from "@src/store/workstation/tabs";

import type { UnifiedTabContentProps } from "../types";

const ProjectWorkitemsCompatTabRenderer: React.FC<UnifiedTabContentProps> =
  memo(({ tab, isActive }) => {
    const { t } = useTranslation("projects");
    const {
      repoPath,
      onOpenProjects,
      onCreateProject,
      onCreateWorkItem,
      onExpandWorkItemToTab,
      onOpenChatSession,
      onOpenRepoSettings,
      onCloseTab,
      onUpdateTabData,
      onUpdateTabMeta,
      onSetTabUnsaved,
      onEmbeddedWorkItemDetailStateChange,
      onProjectListRefreshRequested,
    } = useProjectHostContext();

    const projectView = normalizeProjectDetailSurfaceView(tab.data.projectView);

    return (
      <WorkItemsPage
        projectId={tab.data.projectId as string}
        projectName={tab.data.projectName as string}
        cachedProjectSlug={tab.data.projectSlug as string | undefined}
        repoPath={repoPath}
        projectView={projectView}
        onProjectViewChange={(nextProjectView) => {
          onUpdateTabData(tab.id, { projectView: nextProjectView });
        }}
        breadcrumbSegments={getProjectManagerBreadcrumbSegments(tab, t)}
        workStationTabId={tab.id}
        isActive={isActive}
        onProjectSlugResolved={(slug) => {
          onUpdateTabData(tab.id, { projectSlug: slug });
        }}
        onProjectNameUpdated={(projectName) => {
          onUpdateTabData(tab.id, { projectName });
          onUpdateTabMeta(tab.id, getProjectWorkItemsTabChrome(projectName));
        }}
        onOpenProjects={onOpenProjects}
        onCreateProject={onCreateProject}
        onEmbeddedWorkItemDetailStateChange={(tabId, state) =>
          onEmbeddedWorkItemDetailStateChange(
            tabId,
            state,
            tab.data.projectName as string
          )
        }
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
          pendingUpdates,
          workItemStatus
        ) =>
          onExpandWorkItemToTab(
            tab.data.projectId as string,
            tab.data.projectName as string,
            tab.data.projectSlug as string | undefined,
            workItemId,
            workItemName,
            pendingUpdates,
            workItemStatus
          )
        }
      />
    );
  });

ProjectWorkitemsCompatTabRenderer.displayName =
  "ProjectWorkitemsCompatTabRenderer";

export default ProjectWorkitemsCompatTabRenderer;

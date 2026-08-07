/**
 * Shared implementation for the `project-linear-projects` and
 * `project-linear-work-items` tab renderers.
 *
 * Both tabs render the Linear surface (`LinearProjectsPage`) through the
 * unified dispatcher with identical host-context wiring and breadcrumb /
 * surface derivation — mirroring the `LinearProjectsTabPane` logic in
 * `ProjectManagerContentRouter`. They differ ONLY in the default Linear
 * surface used when `tab.data.linearSurface` is unset, which is supplied by
 * the thin wrappers via `defaultSurface`.
 */
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import LinearProjectsPage from "@src/modules/ProjectManager/LinearProjects";
import { ProjectLinearSurfacePillSwitch } from "@src/modules/ProjectManager/ProjectManagerLayout/components/ProjectLinearSurfacePillSwitch";
import { getProjectManagerBreadcrumbSegments } from "@src/modules/ProjectManager/ProjectManagerLayout/components/projectManagerRouterUtils";
import { useProjectHostContext } from "@src/modules/ProjectManager/ProjectManagerLayout/context/projectHostContext";
import { normalizeProjectLinearSurfaceView } from "@src/store/workstation/tabs";
import type { ProjectLinearSurfaceView } from "@src/store/workstation/tabs";

import type { UnifiedTabContentProps } from "../types";

interface LinearProjectsRendererProps extends UnifiedTabContentProps {
  /** Linear surface to use when `tab.data.linearSurface` is unset. */
  defaultSurface: ProjectLinearSurfaceView;
}

export const LinearProjectsRenderer: React.FC<LinearProjectsRendererProps> = ({
  tab,
  isActive,
  defaultSurface,
}) => {
  const { t } = useTranslation("projects");
  const {
    repoPath,
    onCreateProject,
    onCreateWorkItem,
    onUpdateTabData,
    onEmbeddedWorkItemDetailStateChange,
  } = useProjectHostContext();

  const linearSurface = normalizeProjectLinearSurfaceView(
    tab.data.linearSurface ?? defaultSurface
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
      state: Parameters<typeof onEmbeddedWorkItemDetailStateChange>[1]
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
};

LinearProjectsRenderer.displayName = "LinearProjectsRenderer";

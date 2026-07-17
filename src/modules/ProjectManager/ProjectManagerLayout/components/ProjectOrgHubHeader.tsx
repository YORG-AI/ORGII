import React, { useMemo } from "react";

import type { ProjectOrgSurfaceView } from "@src/store/workstation/tabs";

import ProjectsPageHeader from "../../Projects/components/ProjectsPageHeader";
import type { ProjectManagerBreadcrumbSegment } from "../../shared/components/ProjectManagerBreadcrumb";
import { ProjectOrgSurfacePillSwitch } from "./ProjectOrgSurfacePillSwitch";

export interface ProjectOrgHubHeaderProps {
  breadcrumbSegments: readonly ProjectManagerBreadcrumbSegment[];
  orgView: ProjectOrgSurfaceView;
  onOrgViewChange: (view: ProjectOrgSurfaceView) => void;
  workstationHeaderHost?: "project" | "workManagement";
}

export const ProjectOrgHubHeader: React.FC<ProjectOrgHubHeaderProps> = ({
  breadcrumbSegments,
  orgView,
  onOrgViewChange,
  workstationHeaderHost = "project",
}) => {
  const orgSurfaceControls = useMemo(
    () => (
      <ProjectOrgSurfacePillSwitch
        orgView={orgView}
        onOrgViewChange={onOrgViewChange}
      />
    ),
    [orgView, onOrgViewChange]
  );

  const title = breadcrumbSegments[0]?.label ?? "";

  return (
    <ProjectsPageHeader
      title={title}
      breadcrumbSegments={breadcrumbSegments}
      leadingControls={orgSurfaceControls}
      publishToWorkstationHeader
      workstationHeaderHost={workstationHeaderHost}
    />
  );
};

export default ProjectOrgHubHeader;

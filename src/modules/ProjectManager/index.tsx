/**
 * ProjectManagerPage - Top-level routed Project Manager surface.
 *
 * Mounted persistently by modules/index.tsx (same pattern as WorkStationPage).
 * Visibility is controlled via CSS, not mounting/unmounting.
 */
import React from "react";

import ProjectManagerShell from "@src/modules/ProjectManager/ProjectManagerShell";

export interface ProjectManagerPageProps {
  isActive?: boolean;
}

const ProjectManagerPage: React.FC<ProjectManagerPageProps> = ({
  isActive = true,
}) => {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <ProjectManagerShell isActive={isActive} />
    </div>
  );
};

export default ProjectManagerPage;

/**
 * Renderer for `project-journey` tabs (ORG2-patch).
 */
import React, { memo } from "react";

import { ProjectJourneyPage } from "@src/modules/ProjectManager/ProjectJourney";

import type { UnifiedTabContentProps } from "../types";

const ProjectJourneyTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    return (
      <ProjectJourneyPage
        projectId={tab.data.projectId as string | undefined}
        projectSlug={tab.data.projectSlug as string | undefined}
        projectName={tab.data.projectName as string | undefined}
        forceDemo={Boolean(tab.data.forceDemo)}
      />
    );
  }
);

ProjectJourneyTabRenderer.displayName = "ProjectJourneyTabRenderer";
export default ProjectJourneyTabRenderer;

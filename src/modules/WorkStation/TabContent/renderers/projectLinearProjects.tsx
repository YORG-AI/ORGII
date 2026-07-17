/**
 * Renderer wrapper for `project-linear-projects` tabs.
 *
 * Thin wrapper over the shared `LinearProjectsRenderer` with the PROJECTS
 * surface as the default. See `LinearProjectsRenderer` for the full logic,
 * which mirrors the `LinearProjectsTabPane` logic in
 * `ProjectManagerContentRouter`.
 */
import React, { memo } from "react";

import { PROJECT_LINEAR_SURFACE_VIEW } from "@src/store/workstation/tabs";

import type { UnifiedTabContentProps } from "../types";
import { LinearProjectsRenderer } from "./LinearProjectsRenderer";

const ProjectLinearProjectsTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  (props) => (
    <LinearProjectsRenderer
      {...props}
      defaultSurface={PROJECT_LINEAR_SURFACE_VIEW.PROJECTS}
    />
  )
);

ProjectLinearProjectsTabRenderer.displayName =
  "ProjectLinearProjectsTabRenderer";

export default ProjectLinearProjectsTabRenderer;

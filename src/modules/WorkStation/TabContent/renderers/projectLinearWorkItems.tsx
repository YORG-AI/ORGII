/**
 * Renderer wrapper for `project-linear-work-items` tabs.
 *
 * Thin wrapper over the shared `LinearProjectsRenderer` with the WORK_ITEMS
 * surface as the default. See `LinearProjectsRenderer` for the full logic,
 * which mirrors the `LinearProjectsTabPane` logic in
 * `ProjectManagerContentRouter`.
 */
import React, { memo } from "react";

import { PROJECT_LINEAR_SURFACE_VIEW } from "@src/store/workstation/tabs";

import type { UnifiedTabContentProps } from "../types";
import { LinearProjectsRenderer } from "./LinearProjectsRenderer";

const ProjectLinearWorkItemsTabRenderer: React.FC<UnifiedTabContentProps> =
  memo((props) => (
    <LinearProjectsRenderer
      {...props}
      defaultSurface={PROJECT_LINEAR_SURFACE_VIEW.WORK_ITEMS}
    />
  ));

ProjectLinearWorkItemsTabRenderer.displayName =
  "ProjectLinearWorkItemsTabRenderer";

export default ProjectLinearWorkItemsTabRenderer;

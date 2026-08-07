/**
 * Renderer wrapper for `project-settings` tabs.
 *
 * Renders the repo-settings surface directly from tab data. Despite the old
 * stub note, the router mounts `RepoSettingsTabContent` with only
 * `initialSection` from `tab.data.section` — no host-coupled callbacks — so
 * this needs nothing from the Project host context.
 */
import React, { memo } from "react";

import { RepoSettingsTabContent } from "@src/modules/ProjectManager/ProjectManagerLayout/components/RepoSettingsTabContent";

import type { UnifiedTabContentProps } from "../types";

const ProjectSettingsTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => (
    <RepoSettingsTabContent initialSection={tab.data.section as string} />
  )
);

ProjectSettingsTabRenderer.displayName = "ProjectSettingsTabRenderer";

export default ProjectSettingsTabRenderer;

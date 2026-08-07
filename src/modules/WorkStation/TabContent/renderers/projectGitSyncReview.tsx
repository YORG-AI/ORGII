/**
 * Renderer wrapper for `project-git-sync-review` tabs.
 *
 * Renders directly from tab data. Despite the old stub note, the router
 * mounts `ProjectGitSyncReviewContent` with only `orgId`/`orgName` from
 * `tab.data` — no host-coupled callbacks — so this needs nothing from the
 * Project host context.
 */
import React, { memo } from "react";

import ProjectGitSyncReviewContent from "@src/modules/ProjectManager/ProjectManagerLayout/components/ProjectGitSyncReviewContent";

import type { UnifiedTabContentProps } from "../types";

const ProjectGitSyncReviewTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => (
    <ProjectGitSyncReviewContent
      orgId={tab.data.orgId as string}
      orgName={tab.data.orgName as string | undefined}
    />
  )
);

ProjectGitSyncReviewTabRenderer.displayName = "ProjectGitSyncReviewTabRenderer";

export default ProjectGitSyncReviewTabRenderer;

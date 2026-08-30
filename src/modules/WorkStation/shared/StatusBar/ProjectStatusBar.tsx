/**
 * ProjectStatusBar
 *
 * Status bar for Project Manager, styled to match EditorStatusBar.
 * Right: work item count, member count, sync status.
 */
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { HugeiconsIcon, UserMultipleIcon } from "@src/icons";

import ProjectOrgGitFolderSyncWidget from "./ProjectOrgGitFolderSyncWidget";
import ProjectSyncStatusWidget from "./ProjectSyncStatusWidget";
import {
  BaseStatusBar,
  StatusBarLabel,
  StatusBarSegment,
  StatusBarText,
} from "./StatusBarBase";

export interface ProjectStatusBarProps {
  /** Number of active members */
  activeMemberCount?: number;
  /** Total member count */
  totalMemberCount?: number;
  /** Number of work items in current project */
  workItemCount?: number;
  /**
   * Slug of the active project — used by the sync status widget to look up
   * live worker events. Undefined when no work-items tab is active.
   */
  projectSlug?: string;
  projectOrgId?: string;
  projectOrgName?: string;
  projectOrgGitFolderSyncEnabled?: boolean;
  className?: string;
}

const ProjectStatusBar: React.FC<ProjectStatusBarProps> = memo(
  ({
    activeMemberCount,
    totalMemberCount: _totalMemberCount,
    workItemCount,
    projectSlug,
    projectOrgId,
    projectOrgName,
    projectOrgGitFolderSyncEnabled,
    className,
  }) => {
    const { t } = useTranslation("projects");

    const rightContent = useMemo(
      () => (
        <>
          {workItemCount != null && (
            <StatusBarText>
              {t("statusBar.workItemCount", { count: workItemCount })}
            </StatusBarText>
          )}

          {activeMemberCount != null && (
            <StatusBarSegment>
              <HugeiconsIcon
                icon={UserMultipleIcon}
                data-icon="users"
                size={12}
                className="text-text-1"
              />
              <StatusBarLabel numeric className="text-text-1">
                {activeMemberCount}
              </StatusBarLabel>
            </StatusBarSegment>
          )}

          <ProjectOrgGitFolderSyncWidget
            orgId={projectOrgId}
            orgName={projectOrgName}
            enabled={projectOrgGitFolderSyncEnabled}
          />

          <ProjectSyncStatusWidget projectSlug={projectSlug} />
        </>
      ),
      [
        workItemCount,
        activeMemberCount,
        projectSlug,
        projectOrgId,
        projectOrgName,
        projectOrgGitFolderSyncEnabled,
        t,
      ]
    );

    return (
      <BaseStatusBar
        leftContent={null}
        rightContent={rightContent}
        roundedBottom={false}
        className={className}
      />
    );
  }
);

ProjectStatusBar.displayName = "ProjectStatusBar";

export default ProjectStatusBar;

import React, { memo } from "react";

import type {
  GitHubIssue,
  GitHubIssueTimelineItem,
} from "@src/api/tauri/github";
import { HEADER_CLASSES } from "@src/config/workstation/tokens";
import { GitHubIssueThreadSurface } from "@src/modules/ProjectManager/WorkItems/components";
import type { GitHubIssueInteractionConfig } from "@src/modules/ProjectManager/WorkItems/components/WorkItemContent/types";
import type { WorkItemExternalAssigneeConfig } from "@src/modules/ProjectManager/WorkItems/components/WorkItemProperties/types";
import { ExternalBrowserButton } from "@src/modules/WorkStation/shared/ExternalBrowserButton";
import GitHubIssueHeaderContent from "@src/modules/shared/components/GitHubIssueHeaderContent";

interface IssueDetailPanelProps {
  issue: GitHubIssue;
  timeline: GitHubIssueTimelineItem[];
  timelineLoading: boolean;
  interaction: GitHubIssueInteractionConfig;
  showHeader?: boolean;
  headerClassName?: string;
  assigneeConfig?: WorkItemExternalAssigneeConfig;
}

export function getIssueDetailTitle(issue: GitHubIssue): string {
  return `#${issue.number} ${issue.title}`;
}

export function IssueDetailExternalLinkButton({
  issue,
  title,
}: {
  issue: GitHubIssue;
  title?: string;
}): React.ReactNode {
  return <ExternalBrowserButton href={issue.html_url} label={title} />;
}

export const IssueDetailPanel: React.FC<IssueDetailPanelProps> = memo(
  ({
    issue,
    timeline,
    timelineLoading,
    interaction,
    showHeader = true,
    headerClassName = "",
    assigneeConfig,
  }) => {
    return (
      <div className="allow-select-deep flex h-full min-h-0 select-text flex-col overflow-hidden">
        {showHeader && (
          <div className={`${HEADER_CLASSES.pageHeader} ${headerClassName}`}>
            <GitHubIssueHeaderContent issue={issue} />
            <IssueDetailExternalLinkButton issue={issue} />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-hidden">
          <GitHubIssueThreadSurface
            issue={issue}
            timeline={timeline}
            timelineLoading={timelineLoading}
            interaction={interaction}
            assigneeConfig={assigneeConfig}
          />
        </div>
      </div>
    );
  }
);

IssueDetailPanel.displayName = "IssueDetailPanel";

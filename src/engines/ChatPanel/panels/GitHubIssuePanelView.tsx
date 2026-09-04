import React from "react";

import { Placeholder } from "@src/components/Placeholder";
import {
  IssueDetailPanel,
  IssueDetailTabs,
} from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/IssuesContent/IssueDetailPanel";
import GitHubDetailSkeleton from "@src/modules/shared/components/GitHubDetailSkeleton";
import { useGitHubIssueDetailState } from "@src/modules/shared/hooks/useGitHubIssueDetailState";
import type { GitHubIssueDetailTabData } from "@src/types/githubDetail";

export function GitHubIssuePanelView({
  detail,
}: {
  detail: GitHubIssueDetailTabData;
}): React.ReactNode {
  const { selectedState, interaction, assigneeConfig } =
    useGitHubIssueDetailState(detail);

  if (!selectedState.issue) {
    if (!selectedState.error && (selectedState.loading || detail.remoteUrl)) {
      return (
        <GitHubDetailSkeleton
          kind="issue"
          showHeader={false}
          title={detail.issueTitle}
          number={detail.issueNumber}
          tabs={
            <IssueDetailTabs
              activeTab="conversation"
              conversationCountLoading
              linkedCountLoading
            />
          }
        />
      );
    }
    return (
      <Placeholder
        variant={selectedState.error ? "error" : "empty"}
        placement="detail-panel"
        subtitle={selectedState.error ?? undefined}
        fillParentHeight
      />
    );
  }

  return (
    <IssueDetailPanel
      issue={selectedState.issue}
      timeline={selectedState.timeline}
      timelineLoading={selectedState.timelineLoading}
      interaction={interaction}
      assigneeConfig={assigneeConfig}
    />
  );
}

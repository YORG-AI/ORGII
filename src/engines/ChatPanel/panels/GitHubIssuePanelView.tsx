import React, { useMemo } from "react";

import { usePublishChatPanelHeader } from "@src/engines/ChatPanel/header";
import {
  IssueDetailExternalLinkButton,
  IssueDetailPanel,
} from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/IssuesContent/IssueDetailPanel";
import GitHubDetailSkeleton from "@src/modules/shared/components/GitHubDetailSkeleton";
import GitHubIssueHeaderContent from "@src/modules/shared/components/GitHubIssueHeaderContent";
import { useGitHubIssueDetailState } from "@src/modules/shared/hooks/useGitHubIssueDetailState";
import {
  DetailHeaderTabs,
  Placeholder,
} from "@src/modules/shared/layouts/blocks";
import type { GitHubIssueDetailTabData } from "@src/types/githubDetail";

export function GitHubIssuePanelView({
  detail,
}: {
  detail: GitHubIssueDetailTabData;
}): React.ReactNode {
  const { selectedState, interaction, assigneeConfig } =
    useGitHubIssueDetailState(detail);
  const issueHeaderTitle = useMemo(
    () => (
      <DetailHeaderTabs
        title={
          <GitHubIssueHeaderContent
            issue={selectedState.issue}
            fallbackTitle={`#${detail.issueNumber} ${detail.issueTitle}`}
          />
        }
      />
    ),
    [detail.issueNumber, detail.issueTitle, selectedState.issue]
  );
  const issueHeaderAction = useMemo(
    () =>
      selectedState.issue ? (
        <IssueDetailExternalLinkButton issue={selectedState.issue} />
      ) : null,
    [selectedState.issue]
  );
  const publishedHeader = useMemo(
    () => ({ content: issueHeaderTitle, trailing: issueHeaderAction }),
    [issueHeaderAction, issueHeaderTitle]
  );
  usePublishChatPanelHeader({ content: publishedHeader });

  if (!selectedState.issue) {
    if (!selectedState.error && (selectedState.loading || detail.remoteUrl)) {
      return <GitHubDetailSkeleton kind="issue" showHeader={false} />;
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
      showHeader={false}
      assigneeConfig={assigneeConfig}
    />
  );
}

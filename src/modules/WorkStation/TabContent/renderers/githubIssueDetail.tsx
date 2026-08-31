/**
 * Renderer for `github-issue-detail` tabs.
 *
 * Reads the selected issue from `workstationSelectedIssueAtom` and action
 * callbacks from `workstationIssueCallbackAtom`, then delegates to the
 * existing `IssueDetailPanel` component.
 */
import React, { memo, useMemo } from "react";

import { Placeholder } from "@src/components/Placeholder";
import { usePublishWorkstationTabHeader } from "@src/hooks/tabHost/useWorkstationTabHeader";
import {
  IssueDetailExternalLinkButton,
  IssueDetailPanel,
} from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/IssuesContent/IssueDetailPanel";
import GitHubDetailSkeleton from "@src/modules/shared/components/GitHubDetailSkeleton";
import GitHubIssueHeaderContent from "@src/modules/shared/components/GitHubIssueHeaderContent";
import { useGitHubIssueDetailState } from "@src/modules/shared/hooks/useGitHubIssueDetailState";
import type { GitHubIssueDetailTabData } from "@src/store/workstation/tabs";

import type { UnifiedTabContentProps } from "../types";

const GitHubIssueDetailTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    const tabData = tab.data as unknown as GitHubIssueDetailTabData;
    const { selectedState, interaction, assigneeConfig } =
      useGitHubIssueDetailState(tabData);

    const headerContent = useMemo(
      () => (
        <GitHubIssueHeaderContent
          issue={selectedState.issue}
          fallbackTitle={tab.title}
        />
      ),
      [selectedState.issue, tab.title]
    );

    const headerTrailing = useMemo(() => {
      const issue = selectedState.issue;
      if (!issue) return null;
      return <IssueDetailExternalLinkButton issue={issue} />;
    }, [selectedState.issue]);

    usePublishWorkstationTabHeader({
      host: "code",
      content: {
        content: headerContent,
        trailing: headerTrailing,
        shellLeadingChromeHidden: true,
      },
    });

    if (!selectedState.issue) {
      if (
        !selectedState.error &&
        (selectedState.loading || tabData.remoteUrl)
      ) {
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
        assigneeConfig={assigneeConfig}
        showHeader={false}
      />
    );
  }
);

GitHubIssueDetailTabRenderer.displayName = "GitHubIssueDetailTabRenderer";

export default GitHubIssueDetailTabRenderer;

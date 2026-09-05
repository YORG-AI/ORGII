/**
 * Renderer for `github-issue-detail` tabs.
 *
 * Reads the selected issue from `workstationSelectedIssueAtom` and action
 * callbacks from `workstationIssueCallbackAtom`, then delegates to the
 * existing `IssueDetailPanel` component.
 */
import React, { memo, useMemo } from "react";

import { Placeholder } from "@src/components/Placeholder";
import { useTabViewState } from "@src/hooks/tabHost/useTabViewState";
import { usePublishWorkstationTabHeader } from "@src/hooks/tabHost/useWorkstationTabHeader";
import {
  IssueDetailExternalLinkButton,
  IssueDetailPanel,
  IssueDetailTabs,
} from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/IssuesContent/IssueDetailPanel";
import GitHubDetailSkeleton from "@src/modules/shared/components/GitHubDetailSkeleton";
import {
  extractGitHubReferences,
  getIssueReferenceText,
  parseGitHubRepoFromItemUrl,
} from "@src/modules/shared/components/GitHubLinkedReferences/references";
import type { ThreadDetailTab } from "@src/modules/shared/components/ThreadDetailTabs";
import { useGitHubIssueDetailState } from "@src/modules/shared/hooks/useGitHubIssueDetailState";
import type { GitHubIssueDetailTabData } from "@src/store/workstation/tabs";

import type { UnifiedTabContentProps } from "../types";

const GitHubIssueDetailTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    const tabData = tab.data as unknown as GitHubIssueDetailTabData;
    const { selectedState, interaction, assigneeConfig } =
      useGitHubIssueDetailState(tabData);
    // The tab id is unique per repo + issue number, and the renderer is
    // unmounted on every tab switch, so the sub-tab selection lives in the
    // tab's view state rather than component state.
    const [activeTab, handleTabChange] = useTabViewState<ThreadDetailTab>(
      tab.id,
      "activeTab",
      "conversation"
    );
    const linkedCount = useMemo(() => {
      const issue = selectedState.issue;
      if (!issue) return undefined;
      const defaultRepoFullName = parseGitHubRepoFromItemUrl(issue.html_url);
      return extractGitHubReferences(
        getIssueReferenceText(issue, selectedState.timeline),
        {
          defaultRepoFullName,
          exclude: defaultRepoFullName
            ? { repoFullName: defaultRepoFullName, number: issue.number }
            : undefined,
        }
      ).length;
    }, [selectedState.issue, selectedState.timeline]);

    const headerContent = useMemo(
      () => (
        <IssueDetailTabs
          activeTab={activeTab}
          conversationCount={selectedState.issue?.comments}
          conversationCountLoading={!selectedState.issue}
          linkedCount={linkedCount}
          linkedCountLoading={
            !selectedState.issue || selectedState.timelineLoading
          }
          onChange={handleTabChange}
          variant="header"
        />
      ),
      [
        activeTab,
        handleTabChange,
        linkedCount,
        selectedState.issue,
        selectedState.timelineLoading,
      ]
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
        return (
          <GitHubDetailSkeleton
            kind="issue"
            showHeader={false}
            showTabs={false}
            title={tabData.issueTitle}
            number={tabData.issueNumber}
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
        showHeader={false}
        activeTab={activeTab}
        onTabChange={handleTabChange}
      />
    );
  }
);

GitHubIssueDetailTabRenderer.displayName = "GitHubIssueDetailTabRenderer";

export default GitHubIssueDetailTabRenderer;

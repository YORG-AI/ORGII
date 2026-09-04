import React, { memo, useCallback, useMemo, useState } from "react";

import type {
  GitHubIssue,
  GitHubIssueTimelineItem,
} from "@src/api/tauri/github";
import { GitHubIssueThreadSurface } from "@src/modules/ProjectManager/WorkItems/components";
import type { GitHubIssueInteractionConfig } from "@src/modules/ProjectManager/WorkItems/components/WorkItemContent/types";
import type { WorkItemExternalAssigneeConfig } from "@src/modules/ProjectManager/WorkItems/components/WorkItemProperties/types";
import { ExternalBrowserButton } from "@src/modules/WorkStation/shared/ExternalBrowserButton";
import LazyGitHubLinkedReferences from "@src/modules/shared/components/GitHubLinkedReferences/lazy";
import {
  extractGitHubReferences,
  getIssueReferenceText,
  parseGitHubRepoFromItemUrl,
} from "@src/modules/shared/components/GitHubLinkedReferences/references";
import ThreadDetailTabs, {
  type ThreadDetailTab,
} from "@src/modules/shared/components/ThreadDetailTabs";
import { PersistentDetailTabPanel } from "@src/modules/shared/layouts/blocks";

interface IssueDetailPanelProps {
  issue: GitHubIssue;
  timeline: GitHubIssueTimelineItem[];
  timelineLoading: boolean;
  interaction: GitHubIssueInteractionConfig;
  showHeader?: boolean;
  headerClassName?: string;
  tabActions?: React.ReactNode;
  activeTab?: ThreadDetailTab;
  onTabChange?: (tab: ThreadDetailTab) => void;
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

export function IssueDetailTabs({
  activeTab,
  conversationCount,
  conversationCountLoading,
  linkedCount,
  linkedCountLoading,
  onChange,
  trailing,
  variant = "row",
  className,
}: {
  activeTab: ThreadDetailTab;
  conversationCount?: number;
  conversationCountLoading?: boolean;
  linkedCount?: number;
  linkedCountLoading?: boolean;
  onChange?: (tab: ThreadDetailTab) => void;
  trailing?: React.ReactNode;
  variant?: "row" | "header";
  className?: string;
}): React.ReactNode {
  return (
    <ThreadDetailTabs
      activeTab={activeTab}
      conversationCount={conversationCount}
      conversationCountLoading={conversationCountLoading}
      linkedCount={linkedCount}
      linkedCountLoading={linkedCountLoading}
      onChange={onChange}
      trailing={trailing}
      variant={variant}
      idPrefix="issue-detail"
      className={className}
    />
  );
}

export const IssueDetailPanel: React.FC<IssueDetailPanelProps> = memo(
  ({
    issue,
    timeline,
    timelineLoading,
    interaction,
    showHeader = true,
    headerClassName = "",
    tabActions,
    activeTab: controlledActiveTab,
    onTabChange,
    assigneeConfig,
  }) => {
    const [tabSelection, setTabSelection] = useState<{
      issueUrl: string;
      activeTab: ThreadDetailTab;
    }>({ issueUrl: issue.html_url, activeTab: "conversation" });
    const activeTab =
      controlledActiveTab ??
      (tabSelection.issueUrl === issue.html_url
        ? tabSelection.activeTab
        : "conversation");
    const referenceText = useMemo(
      () => getIssueReferenceText({ body: issue.body }, timeline),
      [issue.body, timeline]
    );
    const defaultRepoFullName = useMemo(
      () => parseGitHubRepoFromItemUrl(issue.html_url),
      [issue.html_url]
    );
    const references = useMemo(
      () =>
        extractGitHubReferences(referenceText, {
          defaultRepoFullName,
          exclude: defaultRepoFullName
            ? { repoFullName: defaultRepoFullName, number: issue.number }
            : undefined,
        }),
      [defaultRepoFullName, issue.number, referenceText]
    );
    const handleTabChange = useCallback(
      (nextTab: ThreadDetailTab) => {
        if (controlledActiveTab === undefined) {
          setTabSelection({ issueUrl: issue.html_url, activeTab: nextTab });
        }
        onTabChange?.(nextTab);
      },
      [controlledActiveTab, issue.html_url, onTabChange]
    );

    return (
      <div className="allow-select-deep flex h-full min-h-0 flex-col overflow-hidden select-text">
        {showHeader && (
          <IssueDetailTabs
            activeTab={activeTab}
            conversationCount={issue.comments}
            linkedCount={references.length}
            linkedCountLoading={timelineLoading}
            onChange={handleTabChange}
            trailing={
              tabActions ?? <IssueDetailExternalLinkButton issue={issue} />
            }
            className={headerClassName}
          />
        )}

        <PersistentDetailTabPanel
          active={activeTab === "conversation"}
          id="issue-detail-tabpanel-conversation"
          ariaLabelledBy="issue-detail-tab-conversation"
          className="min-w-0 overflow-hidden"
        >
          <GitHubIssueThreadSurface
            issue={issue}
            timeline={timeline}
            timelineLoading={timelineLoading}
            interaction={interaction}
            assigneeConfig={assigneeConfig}
          />
        </PersistentDetailTabPanel>

        <PersistentDetailTabPanel
          active={activeTab === "linked"}
          id="issue-detail-tabpanel-linked"
          ariaLabelledBy="issue-detail-tab-linked"
          className="min-w-0 flex-col overflow-hidden"
        >
          <LazyGitHubLinkedReferences
            references={references}
            defaultRepoFullName={defaultRepoFullName}
            enabled={activeTab === "linked"}
          />
        </PersistentDetailTabPanel>
      </div>
    );
  }
);

IssueDetailPanel.displayName = "IssueDetailPanel";

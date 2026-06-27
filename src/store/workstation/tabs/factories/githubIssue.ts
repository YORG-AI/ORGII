/**
 * GitHub Issue Detail Tab Factory
 *
 * Opens a github-issue-detail tab in the main pane when the user clicks an
 * issue row in the sidebar Issues panel.
 */
import { defineTabFactory } from "../tabFactory";
import type { WorkStationTab } from "../types";

export interface GitHubIssueDetailTabData {
  issueNumber: number;
  issueTitle: string;
  repoPath: string;
  remoteUrl?: string;
}

export const githubIssueDetailTabFactory =
  defineTabFactory<GitHubIssueDetailTabData>({
    tabType: "github-issue-detail",
    idStrategy: {
      type: "keyed",
      prefix: "github-issue-detail",
      getKey: (data) => `${data.repoPath}:${data.issueNumber}`,
    },
    getTitle: (data) => `#${data.issueNumber} ${data.issueTitle}`,
    icon: "CircleDot",
  });

export function createGitHubIssueDetailTab(
  issueNumber: number,
  issueTitle: string,
  repoPath: string,
  remoteUrl?: string
): WorkStationTab {
  return githubIssueDetailTabFactory({
    issueNumber,
    issueTitle,
    repoPath,
    remoteUrl,
  });
}

/**
 * GitHub Pull Request Detail Tab Factory
 *
 * Opens a github-pr-detail tab in the main pane when the user clicks a PR row
 * in Kanban (or elsewhere). Mirrors the github-issue-detail factory; the
 * renderer reuses the Source Control `PrDetailPanel`, so the PR opens as a
 * first-class My Station tab rather than in the Source Control sidebar.
 */
import { defineTabFactory } from "../tabFactory";
import type { WorkStationTab } from "../types";

export interface GitHubPrDetailTabData {
  prNumber: number;
  prTitle: string;
  prUrl: string;
  /** open | closed | merged | draft */
  prStatus: string;
  headBranch: string;
  baseBranch?: string;
  repoPath: string;
  repoId?: string;
}

export const githubPrDetailTabFactory = defineTabFactory<GitHubPrDetailTabData>(
  {
    tabType: "github-pr-detail",
    idStrategy: {
      type: "keyed",
      prefix: "github-pr-detail",
      getKey: (data) => `${data.repoPath}:${data.prNumber}`,
    },
    getTitle: (data) => `#${data.prNumber}`,
    icon: "GitPullRequest",
  }
);

export function createGitHubPrDetailTab(
  data: GitHubPrDetailTabData
): WorkStationTab {
  return githubPrDetailTabFactory(data);
}

export interface GitHubIssueDetailTabData {
  issueNumber: number;
  issueTitle: string;
  repoPath: string;
  remoteUrl?: string;
  stateScopeKey?: string;
}

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

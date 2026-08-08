export interface GitHubIssueDetailTabData {
  issueNumber: number;
  issueTitle: string;
  repoPath: string;
  remoteUrl?: string;
  stateScopeKey?: string;
  authScope?: string;
  viewerLogin?: string | null;
  repoPermissions?:
    | import("@src/api/tauri/github").GitHubRepoPermissions
    | null;
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

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
  /** Optional list timestamp used by compact PR previews such as hover cards. */
  updatedAt?: string;
  /** Optional list diff stats used by compact PR previews. */
  additions?: number | null;
  deletions?: number | null;
  repoPath: string;
  repoId?: string;
}

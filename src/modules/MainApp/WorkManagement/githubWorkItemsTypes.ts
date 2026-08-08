import type { GitHubRepoPermissions } from "@src/api/tauri/github";

export type IssueRepoFilter = string;

export interface RepoFilterOption {
  key: IssueRepoFilter;
  label: string;
}

export interface GitHubRepoSource {
  repoId: string;
  repoPath: string;
  label: string;
  remoteUrl: string;
  repoFullName: string;
  viewerLogin: string | null;
  permissions: GitHubRepoPermissions | null;
  authScope?: string | null;
}

export function getGitHubListCacheKey(source: GitHubRepoSource): string {
  const identity =
    source.authScope ||
    source.viewerLogin?.trim().toLowerCase() ||
    "unknown-viewer";
  return `${identity}:${source.repoPath}`;
}

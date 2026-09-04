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

/**
 * Resolves selection to exactly one repository. Obsolete or automatic values
 * fall back to the active repository, then the first available repository.
 */
export function resolveSingleGitHubRepoSource(
  sources: readonly GitHubRepoSource[],
  selectedRepo: string,
  selectedRepoPath: string | null
): GitHubRepoSource | null {
  const directlySelected = sources.find(
    (source) => source.repoFullName === selectedRepo
  );
  if (directlySelected) return directlySelected;

  const currentWorkstationSource = sources.find(
    (source) => source.repoPath === selectedRepoPath
  );
  return currentWorkstationSource ?? sources[0] ?? null;
}

export function getGitHubListCacheKey(source: GitHubRepoSource): string {
  const identity =
    source.authScope ||
    source.viewerLogin?.trim().toLowerCase() ||
    "unknown-viewer";
  return `${identity}:${source.repoPath}`;
}

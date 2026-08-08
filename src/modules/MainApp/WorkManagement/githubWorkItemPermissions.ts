import type { ManagedIssueItem, ManagedPrItem } from "./githubManagedItemModel";
import type { GitHubRepoSource } from "./githubWorkItemsTypes";

function sameLogin(left: string | null, right: string): boolean {
  return left?.trim().toLowerCase() === right.trim().toLowerCase();
}

export function findGitHubRepoSource(
  sources: GitHubRepoSource[],
  repoFullName: string,
  repoPath: string
): GitHubRepoSource | undefined {
  return sources.find(
    (source) =>
      source.repoFullName === repoFullName && source.repoPath === repoPath
  );
}

export function canManageIssueAssignees(
  source: GitHubRepoSource | undefined
): boolean {
  return source?.permissions?.can_manage_issues === true;
}

export function canManageIssueStatus(
  item: ManagedIssueItem,
  source: GitHubRepoSource | undefined
): boolean {
  return (
    source?.permissions?.can_manage_issues === true ||
    sameLogin(item.viewerLogin, item.author)
  );
}

export function canManagePrStatus(
  item: ManagedPrItem,
  source: GitHubRepoSource | undefined
): boolean {
  return (
    source?.permissions?.can_manage_pull_requests === true ||
    item.authoredByViewer
  );
}

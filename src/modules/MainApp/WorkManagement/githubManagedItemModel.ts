import type { GitHubIssue, OpenPRItem } from "@src/api/tauri/github";

import {
  GITHUB_QUERY_SCOPE,
  GITHUB_QUERY_STATE,
} from "./githubWorkItemsSearchQuery";
import type { ParsedGitHubSearchQuery } from "./githubWorkItemsSearchQuery";
import type { GitHubRepoSource } from "./githubWorkItemsTypes";
import { matchesOpsPrQueryState } from "./githubWorkItemsViewCache";

export const GITHUB_ITEM_KIND = {
  ISSUE: "issue",
  PR: "pr",
} as const;

export type IssueState = GitHubIssue["state"];
export type ManagedIssueLabel = GitHubIssue["labels"][number];

export interface ManagedIssueItem {
  kind: typeof GITHUB_ITEM_KIND.ISSUE;
  id: number;
  title: string;
  repo: string;
  repoPath: string;
  remoteUrl: string;
  viewerLogin: string | null;
  authScope?: string | null;
  repoPermissions?: GitHubRepoSource["permissions"];
  rawIssue: GitHubIssue;
  author: string;
  timeAgo: string;
  state: GitHubIssue["state"];
  labels: ManagedIssueLabel[];
  comments: number;
  linkedPullRequests: number;
  updatedAt: string;
}

export interface ManagedPrItem {
  kind: typeof GITHUB_ITEM_KIND.PR;
  id: number;
  title: string;
  repo: string;
  repoId: string;
  repoPath: string;
  remoteUrl: string;
  viewerLogin: string | null;
  rawPr: OpenPRItem;
  author: string;
  authoredByViewer: boolean;
  reviewRequestedFromViewer: boolean;
  timeAgo: string;
  state: string;
  sourceBranch: string;
  targetBranch: string;
  updatedAt: string;
}

export type ManagedGitHubItem = ManagedIssueItem | ManagedPrItem;

export function getManagedGitHubItemKey(item: ManagedGitHubItem): string {
  return `${item.kind}-${item.repo}-${item.id}`;
}

export function getManagedPullRequestKey(pullRequest: ManagedPrItem): string {
  return `${pullRequest.repo}#${pullRequest.id}`;
}

function isSameGitHubLogin(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

export function formatGitHubItemTimeAgo(
  value: string,
  now: number = Date.now()
): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "";
  const elapsedMinutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (elapsedMinutes < 1) return "Now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) return `${elapsedDays}d`;
  const elapsedMonths = Math.floor(elapsedDays / 30);
  if (elapsedMonths < 12) return `${elapsedMonths}mo`;
  return `${Math.floor(elapsedMonths / 12)}y`;
}

export function mapIssueToManagedItem(
  issue: GitHubIssue,
  source: GitHubRepoSource
): ManagedIssueItem {
  return {
    kind: GITHUB_ITEM_KIND.ISSUE,
    id: issue.number,
    title: issue.title,
    repo: source.repoFullName,
    repoPath: source.repoPath,
    remoteUrl: source.remoteUrl,
    viewerLogin: source.viewerLogin,
    authScope: source.authScope,
    repoPermissions: source.permissions,
    rawIssue: issue,
    author: issue.user.login,
    timeAgo: formatGitHubItemTimeAgo(issue.updated_at),
    state: issue.state,
    labels: issue.labels,
    comments: issue.comments,
    linkedPullRequests: issue.linked_pull_requests_count ?? 0,
    updatedAt: issue.updated_at,
  };
}

export function mapPrToManagedItem(
  pr: OpenPRItem,
  source: GitHubRepoSource
): ManagedPrItem {
  const authoredByViewer = isSameGitHubLogin(
    pr.author_login,
    source.viewerLogin
  );
  const reviewRequestedFromViewer = pr.requested_reviewer_logins.some(
    (reviewerLogin) => isSameGitHubLogin(reviewerLogin, source.viewerLogin)
  );
  return {
    kind: GITHUB_ITEM_KIND.PR,
    id: pr.number,
    title: pr.title,
    repo: source.repoFullName,
    repoId: source.repoId,
    repoPath: source.repoPath,
    remoteUrl: source.remoteUrl,
    viewerLogin: source.viewerLogin,
    rawPr: pr,
    author: pr.author_login,
    authoredByViewer,
    reviewRequestedFromViewer,
    timeAgo: formatGitHubItemTimeAgo(pr.updated_at),
    state: pr.state,
    sourceBranch: pr.head_branch,
    targetBranch: pr.base_branch,
    updatedAt: pr.updated_at,
  };
}

export function managedItemMatchesRepo(
  item: ManagedGitHubItem,
  repoFullName: string
): boolean {
  return item.repo === repoFullName;
}

function getSearchableParts(item: ManagedGitHubItem): string[] {
  if (item.kind === GITHUB_ITEM_KIND.ISSUE) {
    return [
      item.title,
      item.repo,
      item.author,
      `#${item.id}`,
      ...item.labels.map((label) => label.name),
    ];
  }
  return [
    item.title,
    item.repo,
    item.author,
    item.sourceBranch,
    item.targetBranch,
    `#${item.id}`,
    `pr #${item.id}`,
  ];
}

export function managedItemMatchesQuery(
  item: ManagedGitHubItem,
  query: ParsedGitHubSearchQuery
): boolean {
  if (
    query.scope === GITHUB_QUERY_SCOPE.ISSUE &&
    item.kind !== GITHUB_ITEM_KIND.ISSUE
  )
    return false;
  if (
    query.scope === GITHUB_QUERY_SCOPE.PR &&
    item.kind !== GITHUB_ITEM_KIND.PR
  )
    return false;
  if (query.state && query.state !== GITHUB_QUERY_STATE.ALL) {
    if (item.kind === GITHUB_ITEM_KIND.PR) {
      if (!matchesOpsPrQueryState(item.state, query.state)) return false;
    } else if (item.state !== query.state) return false;
  }
  if (query.author) {
    const author = item.author;
    const expected = query.author === "@me" ? item.viewerLogin : query.author;
    if (!expected || author.toLowerCase() !== expected.toLowerCase())
      return false;
  }
  if (query.assignee) {
    if (item.kind !== GITHUB_ITEM_KIND.ISSUE) return false;
    const expected =
      query.assignee === "@me" ? item.viewerLogin : query.assignee;
    if (
      !expected ||
      !item.rawIssue.assignees.some(
        (assignee) => assignee.login.toLowerCase() === expected.toLowerCase()
      )
    )
      return false;
  }
  if (query.labels.length > 0) {
    if (item.kind !== GITHUB_ITEM_KIND.ISSUE) return false;
    const labels = new Set(
      item.labels.map((label) => label.name.toLowerCase())
    );
    if (!query.labels.every((label) => labels.has(label.toLowerCase())))
      return false;
  }
  const freeText = query.freeText.toLowerCase();
  return (
    !freeText ||
    getSearchableParts(item).some((part) =>
      part.toLowerCase().includes(freeText)
    )
  );
}

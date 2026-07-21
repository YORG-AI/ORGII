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

export type ManagedIssueLabel = GitHubIssue["labels"][number];

export interface ManagedIssueItem {
  kind: typeof GITHUB_ITEM_KIND.ISSUE;
  id: number;
  title: string;
  repo: string;
  repoPath: string;
  remoteUrl: string;
  viewerLogin: string | null;
  rawIssue: GitHubIssue;
  author: string;
  timeAgo: string;
  state: GitHubIssue["state"];
  labels: ManagedIssueLabel[];
  comments: number;
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
  rawPr: OpenPRItem;
  author: string;
  timeAgo: string;
  state: string;
  sourceBranch: string;
  targetBranch: string;
  updatedAt: string;
}

export type ManagedGitHubItem = ManagedIssueItem | ManagedPrItem;

export function formatGitHubItemTimeAgo(
  value: string,
  now: number = Date.now()
): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "";
  const elapsedMinutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (elapsedMinutes < 1) return "now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) return `${elapsedDays}d ago`;
  const elapsedMonths = Math.floor(elapsedDays / 30);
  if (elapsedMonths < 12) return `${elapsedMonths}mo ago`;
  return `${Math.floor(elapsedMonths / 12)}y ago`;
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
    rawIssue: issue,
    author: issue.user.login,
    timeAgo: formatGitHubItemTimeAgo(issue.updated_at),
    state: issue.state,
    labels: issue.labels,
    comments: issue.comments,
    updatedAt: issue.updated_at,
  };
}

export function mapPrToManagedItem(
  pr: OpenPRItem,
  source: GitHubRepoSource
): ManagedPrItem {
  return {
    kind: GITHUB_ITEM_KIND.PR,
    id: pr.number,
    title: pr.title,
    repo: source.repoFullName,
    repoId: source.repoId,
    repoPath: source.repoPath,
    remoteUrl: source.remoteUrl,
    rawPr: pr,
    author: pr.head_branch,
    timeAgo: formatGitHubItemTimeAgo(pr.updated_at),
    state: pr.state,
    sourceBranch: pr.head_branch,
    targetBranch: pr.base_branch,
    updatedAt: pr.updated_at,
  };
}

export function managedItemMatchesRepo(
  item: ManagedGitHubItem,
  repoFilter: string,
  allReposValue: string
): boolean {
  return repoFilter === allReposValue || item.repo === repoFilter;
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
    const author =
      item.kind === GITHUB_ITEM_KIND.ISSUE ? item.author : item.sourceBranch;
    const expected =
      query.author === "@me" && item.kind === GITHUB_ITEM_KIND.ISSUE
        ? item.viewerLogin
        : query.author;
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

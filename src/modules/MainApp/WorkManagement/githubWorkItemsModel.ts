import { atomWithStorage } from "jotai/utils";

import { getGitRemotes } from "@src/api/http/git/remotes";
import {
  getGitHubGitCredentialForRemote,
  listPRsLocal,
} from "@src/api/tauri/github";
import type {
  GitHubIssue,
  OpenPRItem,
  PullRequestListState,
} from "@src/api/tauri/github";
import {
  coalesceGitHubListRequest,
  getCachedIssues,
  getCachedPrs,
  isIssueCacheStale,
  isPrCacheStale,
  setCachedPrs,
  updateCachedClosedIssues,
  updateCachedOpenIssues,
} from "@src/services/git/githubListCache";
import { parseGithubRepoFullName } from "@src/services/git/operations/createPullRequest";
import { fetchIssues } from "@src/services/git/operations/githubIssues";
import { REPO_KIND } from "@src/store/repo";
import type { Repo } from "@src/store/repo/types";

import { matchesOpsPrQueryState } from "./githubWorkItemsViewCache";

export const ISSUE_REPO_FILTER = {
  ALL: "all",
  CURRENT_WORKSTATION: "currentWorkstation",
} as const;

export const GITHUB_QUERY_SCOPE = {
  ALL: "all",
  ISSUE: "issue",
  PR: "pr",
} as const;

export const GITHUB_FILTER_PRESET = {
  ASSIGNED_TO_ME: "assignedToMe",
  BY_ME: "byMe",
} as const;

export const GITHUB_QUERY_STATE = {
  ALL: "all",
  OPEN: "open",
  CLOSED: "closed",
  MERGED: "merged",
} as const;

export const GITHUB_ITEM_KIND = {
  ISSUE: "issue",
  PR: "pr",
} as const;

export const ISSUE_PAGE_SIZE = 50;
const PR_PAGE_SIZE = 50;

export type IssueRepoFilter = string;
export type GitHubQueryScope =
  (typeof GITHUB_QUERY_SCOPE)[keyof typeof GITHUB_QUERY_SCOPE];
export type GitHubQueryState =
  (typeof GITHUB_QUERY_STATE)[keyof typeof GITHUB_QUERY_STATE];

export const manageIssuesSelectedRepoAtom = atomWithStorage<IssueRepoFilter>(
  "orgii:kanbanGitHub:selectedRepo:v1",
  ISSUE_REPO_FILTER.CURRENT_WORKSTATION
);

export type IssueState = GitHubIssue["state"];
export type IssuePageState = Extract<IssueState, "open" | "closed">;
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
  state: IssueState;
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
  rawPr: OpenPRItem;
  author: string;
  timeAgo: string;
  state: string;
  sourceBranch: string;
  targetBranch: string;
  updatedAt: string;
}

export type ManagedGitHubItem = ManagedIssueItem | ManagedPrItem;

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
}

export interface RepoIssueState {
  openIssues: GitHubIssue[];
  closedIssues: GitHubIssue[];
  openLoaded: boolean;
  closedLoaded: boolean;
  openHasMore: boolean;
  closedHasMore: boolean;
  openNextPage: number | null;
  closedNextPage: number | null;
}

export interface RepoPrState {
  openPrs: OpenPRItem[];
  closedPrs: OpenPRItem[];
  openLoaded: boolean;
  closedLoaded: boolean;
  openError: string | null;
  closedError: string | null;
}

interface RepoIssueLoadResult {
  source: GitHubRepoSource;
  openIssues: GitHubIssue[];
  closedIssues: GitHubIssue[];
  openLoaded: boolean;
  closedLoaded: boolean;
  openHasMore: boolean;
  closedHasMore: boolean;
  openNextPage: number | null;
  closedNextPage: number | null;
  error: string | null;
}

interface RepoPrLoadResult {
  source: GitHubRepoSource;
  state: PullRequestListState;
  prs: OpenPRItem[];
  loaded: boolean;
  error: string | null;
}

export const EMPTY_REPO_ISSUES: RepoIssueState = {
  openIssues: [],
  closedIssues: [],
  openLoaded: false,
  closedLoaded: false,
  openHasMore: false,
  closedHasMore: false,
  openNextPage: null,
  closedNextPage: null,
};

export const EMPTY_REPO_PRS: RepoPrState = {
  openPrs: [],
  closedPrs: [],
  openLoaded: false,
  closedLoaded: false,
  openError: null,
  closedError: null,
};

function formatIssueTimeAgo(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "";

  const elapsedMs = Date.now() - timestamp;
  const elapsedMinutes = Math.max(0, Math.floor(elapsedMs / 60_000));
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

export function mapIssueToManagedIssue(
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
    timeAgo: formatIssueTimeAgo(issue.updated_at),
    state: issue.state,
    labels: issue.labels,
    comments: issue.comments,
    linkedPullRequests: issue.linked_pull_requests_count ?? 0,
    updatedAt: issue.updated_at,
  };
}

export function mapPrToManagedPr(
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
    timeAgo: formatIssueTimeAgo(pr.updated_at),
    state: pr.state,
    sourceBranch: pr.head_branch,
    targetBranch: pr.base_branch,
    updatedAt: pr.updated_at,
  };
}

export function itemMatchesRepo(
  item: ManagedGitHubItem,
  repoFilter: IssueRepoFilter
): boolean {
  return repoFilter === ISSUE_REPO_FILTER.ALL || item.repo === repoFilter;
}

interface GitHubSearchToken {
  value: string;
  raw: string;
}

export interface ParsedGitHubSearchQuery {
  scope: GitHubQueryScope;
  state: GitHubQueryState | null;
  labels: string[];
  author: string | null;
  assignee: string | null;
  freeText: string;
}

function tokenizeGitHubSearchQuery(rawQuery: string): GitHubSearchToken[] {
  const tokens: GitHubSearchToken[] = [];
  let value = "";
  let raw = "";
  let quote: '"' | "'" | null = null;

  const flush = () => {
    if (!value && !raw) return;
    tokens.push({ value, raw });
    value = "";
    raw = "";
  };

  for (const char of rawQuery) {
    if (/\s/.test(char) && quote === null) {
      flush();
      continue;
    }

    raw += char;
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    value += char;
  }

  flush();
  return tokens;
}

function serializeGitHubTokenValue(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export function serializeGitHubSearchQuery(
  query: ParsedGitHubSearchQuery
): string {
  const parts: string[] = [];
  if (query.scope === GITHUB_QUERY_SCOPE.ISSUE) parts.push("is:issue");
  if (query.scope === GITHUB_QUERY_SCOPE.PR) parts.push("is:pr");
  if (query.state === GITHUB_QUERY_STATE.OPEN) parts.push("is:open");
  if (query.state === GITHUB_QUERY_STATE.CLOSED) parts.push("is:closed");
  if (query.state === GITHUB_QUERY_STATE.MERGED) parts.push("is:merged");
  if (query.state === GITHUB_QUERY_STATE.ALL) parts.push("state:all");
  if (query.assignee)
    parts.push(`assignee:${serializeGitHubTokenValue(query.assignee)}`);
  if (query.author)
    parts.push(`author:${serializeGitHubTokenValue(query.author)}`);
  for (const label of query.labels) {
    parts.push(`label:${serializeGitHubTokenValue(label)}`);
  }
  if (query.freeText) parts.push(query.freeText);
  return parts.join(" ");
}

export function parseGitHubSearchQuery(
  rawQuery: string
): ParsedGitHubSearchQuery {
  const query: ParsedGitHubSearchQuery = {
    scope: GITHUB_QUERY_SCOPE.ALL,
    state: null,
    labels: [],
    author: null,
    assignee: null,
    freeText: "",
  };
  const freeTextTokens: string[] = [];
  let sawIssueScope = false;
  let sawPrScope = false;

  for (const { value: token, raw } of tokenizeGitHubSearchQuery(
    rawQuery.trim()
  )) {
    const normalized = token.toLowerCase();
    if (normalized === "is:issue") {
      sawIssueScope = true;
      query.scope = sawPrScope
        ? GITHUB_QUERY_SCOPE.ALL
        : GITHUB_QUERY_SCOPE.ISSUE;
      continue;
    }
    if (normalized === "is:pr" || normalized === "is:pull-request") {
      sawPrScope = true;
      query.scope = sawIssueScope
        ? GITHUB_QUERY_SCOPE.ALL
        : GITHUB_QUERY_SCOPE.PR;
      continue;
    }
    if (normalized === "is:open") {
      query.state = GITHUB_QUERY_STATE.OPEN;
      continue;
    }
    if (normalized === "is:closed") {
      query.state = GITHUB_QUERY_STATE.CLOSED;
      continue;
    }
    if (normalized === "is:merged") {
      query.scope = GITHUB_QUERY_SCOPE.PR;
      query.state = GITHUB_QUERY_STATE.MERGED;
      continue;
    }

    const [rawKey, ...rest] = token.split(":");
    const qualifierValue = rest.join(":").trim();
    const key = rawKey.toLowerCase();
    if (!qualifierValue) {
      freeTextTokens.push(raw);
      continue;
    }

    if (key === "label") {
      query.labels.push(qualifierValue);
      continue;
    }
    if (key === "author") {
      query.author = qualifierValue;
      continue;
    }
    if (key === "assignee") {
      query.assignee = qualifierValue;
      continue;
    }
    if (key === "state") {
      const normalizedValue = qualifierValue.toLowerCase();
      if (
        normalizedValue === GITHUB_QUERY_STATE.OPEN ||
        normalizedValue === GITHUB_QUERY_STATE.CLOSED ||
        normalizedValue === GITHUB_QUERY_STATE.MERGED ||
        normalizedValue === GITHUB_QUERY_STATE.ALL
      ) {
        query.state = normalizedValue;
        continue;
      }
    }

    freeTextTokens.push(raw);
  }

  query.freeText = freeTextTokens.join(" ").trim();
  return query;
}

function normalizedSearchParts(item: ManagedGitHubItem): string[] {
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

export function itemMatchesParsedQuery(
  item: ManagedGitHubItem,
  query: ParsedGitHubSearchQuery
): boolean {
  if (
    query.scope === GITHUB_QUERY_SCOPE.ISSUE &&
    item.kind !== GITHUB_ITEM_KIND.ISSUE
  ) {
    return false;
  }
  if (
    query.scope === GITHUB_QUERY_SCOPE.PR &&
    item.kind !== GITHUB_ITEM_KIND.PR
  ) {
    return false;
  }
  if (query.state && query.state !== GITHUB_QUERY_STATE.ALL) {
    if (item.kind === GITHUB_ITEM_KIND.PR) {
      if (!matchesOpsPrQueryState(item.state, query.state)) return false;
    } else if (item.state !== query.state) {
      return false;
    }
  }
  if (query.author) {
    const author =
      item.kind === GITHUB_ITEM_KIND.ISSUE ? item.author : item.sourceBranch;
    const expectedAuthor =
      query.author === "@me" && item.kind === GITHUB_ITEM_KIND.ISSUE
        ? item.viewerLogin
        : query.author;
    if (
      !expectedAuthor ||
      author.toLowerCase() !== expectedAuthor.toLowerCase()
    ) {
      return false;
    }
  }
  if (query.assignee) {
    if (item.kind !== GITHUB_ITEM_KIND.ISSUE) return false;
    const expectedAssignee =
      query.assignee === "@me" ? item.viewerLogin : query.assignee;
    if (!expectedAssignee) return false;
    const assigneeMatched = item.rawIssue.assignees.some(
      (assignee) =>
        assignee.login.toLowerCase() === expectedAssignee.toLowerCase()
    );
    if (!assigneeMatched) return false;
  }
  if (query.labels.length > 0) {
    if (item.kind !== GITHUB_ITEM_KIND.ISSUE) return false;
    const labelNames = new Set(
      item.labels.map((label) => label.name.toLowerCase())
    );
    if (!query.labels.every((label) => labelNames.has(label.toLowerCase()))) {
      return false;
    }
  }

  const normalizedFreeText = query.freeText.toLowerCase();
  if (!normalizedFreeText) return true;
  return normalizedSearchParts(item).some((part) =>
    part.toLowerCase().includes(normalizedFreeText)
  );
}

export function getIssuePageStatesForQuery(
  query: ParsedGitHubSearchQuery
): IssuePageState[] {
  if (query.scope === GITHUB_QUERY_SCOPE.PR) return [];
  if (query.state === GITHUB_QUERY_STATE.OPEN) return ["open"];
  if (query.state === GITHUB_QUERY_STATE.CLOSED) return ["closed"];
  return ["open", "closed"];
}

export function getCachedRepoIssues(source: GitHubRepoSource): RepoIssueState {
  const cached = getCachedIssues(source.repoPath);
  if (!cached) return EMPTY_REPO_ISSUES;
  return {
    openIssues: cached.openIssues,
    closedIssues: cached.closedIssues,
    openLoaded: typeof cached.openCachedAt === "number",
    closedLoaded: typeof cached.closedCachedAt === "number",
    openHasMore: cached.openIssues.length >= ISSUE_PAGE_SIZE,
    closedHasMore: cached.closedIssues.length >= ISSUE_PAGE_SIZE,
    openNextPage: cached.openIssues.length >= ISSUE_PAGE_SIZE ? 2 : null,
    closedNextPage: cached.closedIssues.length >= ISSUE_PAGE_SIZE ? 2 : null,
  };
}

export function getCachedRepoPrs(source: GitHubRepoSource): RepoPrState {
  const open = getCachedPrs(source.repoPath, "open");
  const closed = getCachedPrs(source.repoPath, "closed");
  return {
    openPrs: open?.prs ?? [],
    closedPrs: closed?.prs ?? [],
    openLoaded: Boolean(open),
    closedLoaded: Boolean(closed),
    openError: null,
    closedError: null,
  };
}

export function getRepoIssueMapKey(source: GitHubRepoSource): string {
  return source.repoFullName;
}

export function mergeUniqueIssues(
  existingIssues: GitHubIssue[],
  incomingIssues: GitHubIssue[]
): GitHubIssue[] {
  const seenIssueNumbers = new Set(existingIssues.map((issue) => issue.number));
  return [
    ...existingIssues,
    ...incomingIssues.filter((issue) => !seenIssueNumbers.has(issue.number)),
  ];
}

export async function resolveGitHubRepoSource(
  repo: Repo
): Promise<GitHubRepoSource | null> {
  if (repo.kind !== REPO_KIND.GIT || !repo.path) return null;

  const remoteUrl = repo.repo_url
    ? repo.repo_url
    : (
        await getGitRemotes({
          repo_id: repo.id,
          repo_path: repo.path,
        })
      )?.remotes?.find((remote) => remote.name === "origin")?.url;

  if (!remoteUrl) return null;
  const repoFullName = parseGithubRepoFullName(remoteUrl);
  if (!repoFullName) return null;
  const credential = await getGitHubGitCredentialForRemote(remoteUrl);

  return {
    repoId: repo.id,
    repoPath: repo.path,
    label: repo.name,
    remoteUrl,
    repoFullName,
    viewerLogin: credential?.username ?? null,
  };
}

export async function loadRepoIssues(
  source: GitHubRepoSource,
  states: IssuePageState[],
  force = false
): Promise<RepoIssueLoadResult> {
  const cached = getCachedRepoIssues(source);
  if (
    !force &&
    states.every((state) => !isIssueCacheStale(source.repoPath, state))
  ) {
    return {
      source,
      openIssues: cached.openIssues,
      closedIssues: cached.closedIssues,
      openLoaded: cached.openLoaded,
      closedLoaded: cached.closedLoaded,
      openHasMore: cached.openHasMore,
      closedHasMore: cached.closedHasMore,
      openNextPage: cached.openNextPage,
      closedNextPage: cached.closedNextPage,
      error: null,
    };
  }

  const results = await coalesceGitHubListRequest(
    `work-management:issues:${states.join(",")}:${source.repoPath}`,
    () =>
      Promise.all(
        states.map((state) =>
          fetchIssues(source.remoteUrl, {
            state,
            page: 1,
            perPage: ISSUE_PAGE_SIZE,
          })
        )
      )
  );

  const resultByState = new Map(
    states.map((state, index) => [state, results[index]] as const)
  );
  const openResult = resultByState.get("open");
  const closedResult = resultByState.get("closed");
  const openIssues = openResult?.data?.issues ?? cached.openIssues;
  const closedIssues = closedResult?.data?.issues ?? cached.closedIssues;

  if (openResult?.data) updateCachedOpenIssues(source.repoPath, openIssues);
  if (closedResult?.data)
    updateCachedClosedIssues(source.repoPath, closedIssues);

  return {
    source,
    openIssues,
    closedIssues,
    openLoaded: Boolean(openResult?.data) || cached.openLoaded,
    closedLoaded: Boolean(closedResult?.data) || cached.closedLoaded,
    openHasMore: openResult?.data?.has_more ?? cached.openHasMore,
    closedHasMore: closedResult?.data?.has_more ?? cached.closedHasMore,
    openNextPage: openResult?.data?.next_page ?? cached.openNextPage,
    closedNextPage: closedResult?.data?.next_page ?? cached.closedNextPage,
    error: openResult?.error ?? closedResult?.error ?? null,
  };
}

export async function loadRepoPrs(
  source: GitHubRepoSource,
  state: PullRequestListState,
  force = false
): Promise<RepoPrLoadResult> {
  const cached = getCachedPrs(source.repoPath, state);
  if (cached && !force && !isPrCacheStale(source.repoPath, state)) {
    return { source, state, prs: cached.prs, loaded: true, error: null };
  }

  try {
    const prs = await coalesceGitHubListRequest(
      `work-management:prs:${state}:${source.repoPath}`,
      () => listPRsLocal(source.repoFullName, state, PR_PAGE_SIZE)
    );
    setCachedPrs(source.repoPath, prs, state);
    return { source, state, prs, loaded: true, error: null };
  } catch (err: unknown) {
    return {
      source,
      state,
      prs: cached?.prs ?? [],
      loaded: Boolean(cached),
      error: String(err),
    };
  }
}

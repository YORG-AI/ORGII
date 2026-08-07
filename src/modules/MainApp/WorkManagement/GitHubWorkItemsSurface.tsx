import { useVirtualizer } from "@tanstack/react-virtual";
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import {
  CheckCircle2,
  CircleDot,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Link2,
  MessageSquare,
  MoreHorizontal,
} from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { getGitRemotes } from "@src/api/http/git/remotes";
import {
  getGitHubGitCredentialForRemote,
  listPRsLocal,
} from "@src/api/tauri/github";
import type {
  GitHubIssue,
  GitHubIssueComment,
  OpenPRItem,
  PullRequestListState,
} from "@src/api/tauri/github";
import Button from "@src/components/Button";
import Dropdown from "@src/components/Dropdown";
import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import Input from "@src/components/Input";
import Message from "@src/components/Message";
import { SearchInput } from "@src/components/SearchInput";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import { usePublishWorkstationTabHeader } from "@src/hooks/workStation";
import { useWorkStationTabs } from "@src/hooks/workStation/tabs";
import {
  IssueDetailHeaderContent,
  IssueDetailPanel,
} from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/IssuesContent/IssueDetailPanel";
import {
  DetailPanelContainer,
  Placeholder,
} from "@src/modules/shared/layouts/blocks";
import Modal from "@src/scaffold/ModalSystem";
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
import {
  addIssueComment,
  closeIssue,
  createIssue,
  fetchIssueComments,
  fetchIssues,
  reopenIssue,
} from "@src/services/git/operations/githubIssues";
import { WorkStationViewService } from "@src/services/workStation/WorkStationViewService";
import { getPrStatusVariant } from "@src/shared/pr/prStatus";
import { REPO_KIND, reposAtom, selectedRepoPathAtom } from "@src/store/repo";
import type { Repo } from "@src/store/repo/types";
import { addToAgentAtom } from "@src/store/ui/addToAgentAtom";
import { workstationSelectedIssueAtomFamily } from "@src/store/workstation/codeEditor/workstationIssueAtom";
import { workstationRepoScopeKey } from "@src/store/workstation/codeEditor/workstationPrAtom";
import {
  createGitHubIssueDetailTab,
  createGitHubPrDetailTab,
} from "@src/store/workstation/tabs";
import { openExternalLink } from "@src/util/platform/ipcRenderer";

import {
  GitHubWorkItemListFrame,
  GitHubWorkItemPagination,
  GitHubWorkItemRow,
  GitHubWorkItemSummary,
  GitHubWorkItemToolbarActions,
} from "./GitHubWorkItemList";
import {
  canAdvanceGitHubWorkItemsPage,
  getGitHubWorkItemsPage,
  getGitHubWorkItemsPageCount,
} from "./githubWorkItemsPagination";
import {
  getCachedOpsGitHubView,
  getOpsPrListStates,
  matchesOpsPrQueryState,
  setCachedOpsGitHubView,
} from "./githubWorkItemsViewCache";

const ISSUE_REPO_FILTER = {
  ALL: "all",
  CURRENT_WORKSTATION: "currentWorkstation",
} as const;

const GITHUB_QUERY_SCOPE = {
  ALL: "all",
  ISSUE: "issue",
  PR: "pr",
} as const;

const GITHUB_FILTER_PRESET = {
  ASSIGNED_TO_ME: "assignedToMe",
  BY_ME: "byMe",
} as const;

const GITHUB_QUERY_STATE = {
  ALL: "all",
  OPEN: "open",
  CLOSED: "closed",
  MERGED: "merged",
} as const;

const GITHUB_ITEM_KIND = {
  ISSUE: "issue",
  PR: "pr",
} as const;

const ISSUE_PAGE_SIZE = 50;
const PR_PAGE_SIZE = 50;

type IssueRepoFilter = string;
type GitHubQueryScope =
  (typeof GITHUB_QUERY_SCOPE)[keyof typeof GITHUB_QUERY_SCOPE];
type GitHubQueryState =
  (typeof GITHUB_QUERY_STATE)[keyof typeof GITHUB_QUERY_STATE];

const manageIssuesSelectedRepoAtom = atomWithStorage<IssueRepoFilter>(
  "orgii:kanbanGitHub:selectedRepo:v1",
  ISSUE_REPO_FILTER.CURRENT_WORKSTATION
);

type IssueState = GitHubIssue["state"];
type IssuePageState = Extract<IssueState, "open" | "closed">;
type ManagedIssueLabel = GitHubIssue["labels"][number];

interface ManagedIssueItem {
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
  updatedAt: string;
}

interface IssueDetailState {
  source: ManagedIssueItem;
  issue: GitHubIssue;
  comments: GitHubIssueComment[];
  commentsLoading: boolean;
  submittingComment: boolean;
  error: string | null;
}

interface ManagedPrItem {
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

type ManagedGitHubItem = ManagedIssueItem | ManagedPrItem;

interface RepoFilterOption {
  key: IssueRepoFilter;
  label: string;
}

interface GitHubRepoSource {
  repoId: string;
  repoPath: string;
  label: string;
  remoteUrl: string;
  repoFullName: string;
  viewerLogin: string | null;
}

interface RepoIssueState {
  openIssues: GitHubIssue[];
  closedIssues: GitHubIssue[];
  openLoaded: boolean;
  closedLoaded: boolean;
  openHasMore: boolean;
  closedHasMore: boolean;
  openNextPage: number | null;
  closedNextPage: number | null;
}

interface RepoPrState {
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

const EMPTY_REPO_ISSUES: RepoIssueState = {
  openIssues: [],
  closedIssues: [],
  openLoaded: false,
  closedLoaded: false,
  openHasMore: false,
  closedHasMore: false,
  openNextPage: null,
  closedNextPage: null,
};

const EMPTY_REPO_PRS: RepoPrState = {
  openPrs: [],
  closedPrs: [],
  openLoaded: false,
  closedLoaded: false,
  openError: null,
  closedError: null,
};

function ManagedIssueStateIcon({
  state,
}: {
  state: IssueState;
}): React.ReactNode {
  if (state === "closed") {
    return <CheckCircle2 size={14} strokeWidth={1.8} />;
  }
  return <CircleDot size={14} strokeWidth={1.8} />;
}

function getGitHubLabelTextColor(color: string): string {
  const normalizedColor = color.replace("#", "");
  const red = parseInt(normalizedColor.slice(0, 2), 16);
  const green = parseInt(normalizedColor.slice(2, 4), 16);
  const blue = parseInt(normalizedColor.slice(4, 6), 16);
  const luminance = (red * 299 + green * 587 + blue * 114) / 1000;
  return luminance > 140 ? "#24292f" : "#ffffff";
}

function IssueLabelTag({
  label,
}: {
  label: ManagedIssueLabel;
}): React.ReactNode {
  const backgroundColor = `#${label.color.replace("#", "")}`;

  return (
    <span
      className="inline-flex h-5 items-center rounded-full px-[7px] text-[11px] font-semibold leading-none"
      style={{
        backgroundColor,
        color: getGitHubLabelTextColor(backgroundColor),
      }}
    >
      {label.name}
    </span>
  );
}

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

function mapIssueToManagedIssue(
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
    updatedAt: issue.updated_at,
  };
}

function mapPrToManagedPr(
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

function itemMatchesRepo(
  item: ManagedGitHubItem,
  repoFilter: IssueRepoFilter
): boolean {
  return repoFilter === ISSUE_REPO_FILTER.ALL || item.repo === repoFilter;
}

interface GitHubSearchToken {
  value: string;
  raw: string;
}

interface ParsedGitHubSearchQuery {
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

function serializeGitHubSearchQuery(query: ParsedGitHubSearchQuery): string {
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

function parseGitHubSearchQuery(rawQuery: string): ParsedGitHubSearchQuery {
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

function itemMatchesParsedQuery(
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

function getIssuePageStatesForQuery(
  query: ParsedGitHubSearchQuery
): IssuePageState[] {
  if (query.scope === GITHUB_QUERY_SCOPE.PR) return [];
  if (query.state === GITHUB_QUERY_STATE.OPEN) return ["open"];
  if (query.state === GITHUB_QUERY_STATE.CLOSED) return ["closed"];
  return ["open", "closed"];
}

function getCachedRepoIssues(source: GitHubRepoSource): RepoIssueState {
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

function getCachedRepoPrs(source: GitHubRepoSource): RepoPrState {
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

function getRepoIssueMapKey(source: GitHubRepoSource): string {
  return source.repoFullName;
}

function mergeUniqueIssues(
  existingIssues: GitHubIssue[],
  incomingIssues: GitHubIssue[]
): GitHubIssue[] {
  const seenIssueNumbers = new Set(existingIssues.map((issue) => issue.number));
  return [
    ...existingIssues,
    ...incomingIssues.filter((issue) => !seenIssueNumbers.has(issue.number)),
  ];
}

async function resolveGitHubRepoSource(
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

async function loadRepoIssues(
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

async function loadRepoPrs(
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
    return {
      source,
      state,
      prs,
      loaded: true,
      error: null,
    };
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

function RepoFilterPill({
  options,
  selectedRepo,
  allReposLabel,
  onSelectRepo,
}: {
  options: RepoFilterOption[];
  selectedRepo: IssueRepoFilter;
  allReposLabel: string;
  onSelectRepo: (repo: IssueRepoFilter) => void;
}): React.ReactNode {
  const selectOptions = useMemo<SelectOption[]>(
    () =>
      options.map((option) => ({
        value: option.key,
        label: option.label,
        triggerLabel: option.label,
      })),
    [options]
  );

  return (
    <Select
      value={selectedRepo}
      options={selectOptions}
      placeholder={allReposLabel}
      size="small"
      showSearch
      variant="default"
      radius="lg"
      dropdownWidthMode="match"
      className="min-w-[190px] max-w-[260px]"
      selectorClassName="h-7"
      onChange={(value) => onSelectRepo(String(value))}
    />
  );
}

function ManagedIssueRow({
  issue,
  addLabel,
  openInBrowserLabel,
  openInMyStationLabel,
  moreActionsLabel,
  onOpenIssue,
  onOpenIssueInBrowser,
  onOpenIssueInMyStation,
  onAddIssue,
}: {
  issue: ManagedIssueItem;
  addLabel: string;
  openInBrowserLabel: string;
  openInMyStationLabel: string;
  moreActionsLabel: string;
  onOpenIssue: (issue: ManagedIssueItem) => void;
  onOpenIssueInBrowser: (issue: ManagedIssueItem) => void;
  onOpenIssueInMyStation: (issue: ManagedIssueItem) => void;
  onAddIssue: (issue: ManagedIssueItem) => void;
}): React.ReactNode {
  const [menuVisible, setMenuVisible] = useState(false);
  const stateClassName =
    issue.state === "closed" ? "text-purple-6" : "text-success-6";
  const closeMenu = useCallback(() => setMenuVisible(false), []);
  const droplist = (
    <div className={`${DROPDOWN_CLASSES.menuPanelBase} min-w-[180px]`}>
      <button
        type="button"
        className={DROPDOWN_CLASSES.menuActionItem}
        onClick={() => {
          onOpenIssueInBrowser(issue);
          closeMenu();
        }}
      >
        <span className="min-w-0 flex-1 truncate">{openInBrowserLabel}</span>
      </button>
      <button
        type="button"
        className={DROPDOWN_CLASSES.menuActionItem}
        onClick={() => {
          onOpenIssueInMyStation(issue);
          closeMenu();
        }}
      >
        <span className="min-w-0 flex-1 truncate">{openInMyStationLabel}</span>
      </button>
    </div>
  );

  return (
    <GitHubWorkItemRow
      icon={
        <span className={stateClassName}>
          <ManagedIssueStateIcon state={issue.state} />
        </span>
      }
      content={
        <button
          type="button"
          className="min-w-0 flex-1 text-left focus-visible:outline-none"
          onClick={() => onOpenIssue(issue)}
          aria-label={`Open issue #${issue.id}: ${issue.title}`}
        >
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <h3 className="m-0 min-w-0 text-[13px] font-semibold leading-5 text-text-1 group-hover:text-primary-6">
              {issue.title}
            </h3>
            {issue.labels.map((label) => (
              <IssueLabelTag key={label.name} label={label} />
            ))}
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-text-3">
            <span>#{issue.id}</span>
            <span>·</span>
            <span>{issue.repo}</span>
            <span>·</span>
            <span>{issue.author}</span>
            <span>·</span>
            <span>{issue.timeAgo}</span>
          </div>
        </button>
      }
      trailing={
        <>
          {issue.comments > 0 ? (
            <span className="mt-1 flex shrink-0 items-center gap-1 text-[11px] text-text-3">
              <MessageSquare size={12} strokeWidth={1.8} />
              {issue.comments}
            </span>
          ) : null}
          <img
            src={issue.rawIssue.user.avatar_url}
            alt=""
            title={issue.author}
            className="mt-0.5 h-6 w-6 shrink-0 rounded-full bg-fill-2 object-cover"
          />
        </>
      }
      actions={
        <>
          <Button
            htmlType="button"
            variant="tertiary"
            appearance="ghost"
            size="mini"
            icon={<Link2 size={12} />}
            className="mt-0.5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              onAddIssue(issue);
            }}
            aria-label={`Add issue #${issue.id} to chat`}
          >
            {addLabel}
          </Button>
          <span onClick={(event) => event.stopPropagation()}>
            <Dropdown
              droplist={droplist}
              trigger="click"
              position="bottom-end"
              popupVisible={menuVisible}
              onVisibleChange={setMenuVisible}
            >
              <Button
                htmlType="button"
                variant="tertiary"
                appearance="ghost"
                size="mini"
                icon={<MoreHorizontal size={13} />}
                iconOnly
                className="mt-0.5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                aria-label={moreActionsLabel}
                aria-expanded={menuVisible}
              />
            </Dropdown>
          </span>
        </>
      }
    />
  );
}

function ManagedPrRow({
  pr,
  addLabel,
  onOpenPr,
  onAddPr,
}: {
  pr: ManagedPrItem;
  addLabel: string;
  onOpenPr: (pr: ManagedPrItem) => void;
  onAddPr: (pr: ManagedPrItem) => void;
}): React.ReactNode {
  const statusVariant = getPrStatusVariant(pr.state);
  const PrIcon =
    pr.state === GITHUB_QUERY_STATE.MERGED
      ? GitMerge
      : pr.state === GITHUB_QUERY_STATE.CLOSED
        ? GitPullRequestClosed
        : GitPullRequest;

  return (
    <GitHubWorkItemRow
      icon={
        <span className={statusVariant.dotClass.replace("bg-", "text-")}>
          <PrIcon size={14} strokeWidth={1.8} />
        </span>
      }
      content={
        <button
          type="button"
          className="min-w-0 flex-1 text-left focus-visible:outline-none"
          onClick={() => onOpenPr(pr)}
          aria-label={`Open pull request #${pr.id}: ${pr.title}`}
        >
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <h3 className="m-0 min-w-0 text-[13px] font-semibold leading-5 text-text-1 group-hover:text-primary-6">
              {pr.title}
            </h3>
            {pr.rawPr.draft ? (
              <span className="rounded-full border border-border-2 bg-fill-1 px-1.5 py-0.5 text-[10px] font-medium text-text-2">
                Draft
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-text-3">
            <span>#{pr.id}</span>
            <span>·</span>
            <span>{pr.repo}</span>
            <span>·</span>
            <span>{pr.sourceBranch}</span>
            <span>→</span>
            <span>{pr.targetBranch}</span>
            <span>·</span>
            <span>{pr.timeAgo}</span>
          </div>
        </button>
      }
      actions={
        <Button
          htmlType="button"
          variant="tertiary"
          appearance="ghost"
          size="mini"
          icon={<Link2 size={12} />}
          className="mt-0.5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
          onClick={() => onAddPr(pr)}
          aria-label={`Add pull request #${pr.id} to chat`}
        >
          {addLabel}
        </Button>
      }
    />
  );
}

interface CreateIssueModalProps {
  open: boolean;
  repoSources: GitHubRepoSource[];
  selectedRepo: GitHubRepoSource | null;
  creating: boolean;
  labels: {
    title: string;
    issueTitlePlaceholder: string;
    issueBodyPlaceholder: string;
    repository: string;
    cancel: string;
    create: string;
    creating: string;
  };
  onCreateIssue: (
    source: GitHubRepoSource,
    title: string,
    body: string
  ) => void;
  onCancel: () => void;
}

function CreateIssueModal({
  open,
  repoSources,
  selectedRepo,
  creating,
  labels,
  onCreateIssue,
  onCancel,
}: CreateIssueModalProps): React.ReactNode {
  const [repoKey, setRepoKey] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const effectiveRepoKey =
    repoKey || selectedRepo?.repoFullName || repoSources[0]?.repoFullName || "";
  const source =
    repoSources.find(
      (repoSource) => repoSource.repoFullName === effectiveRepoKey
    ) ??
    selectedRepo ??
    repoSources[0] ??
    null;
  const repoOptions = useMemo<SelectOption[]>(
    () =>
      repoSources.map((repoSource) => ({
        label: repoSource.repoFullName,
        value: repoSource.repoFullName,
      })),
    [repoSources]
  );

  const handleCancel = () => {
    setRepoKey("");
    setTitle("");
    setBody("");
    onCancel();
  };

  const handleCreate = () => {
    const trimmedTitle = title.trim();
    if (!source || !trimmedTitle) return;
    onCreateIssue(source, trimmedTitle, body.trim());
    setRepoKey("");
    setTitle("");
    setBody("");
  };

  return (
    <Modal
      visible={open}
      title={labels.title}
      onCancel={handleCancel}
      onOk={handleCreate}
      okText={creating ? labels.creating : labels.create}
      cancelText={labels.cancel}
      okButtonProps={{ loading: creating, disabled: !source || !title.trim() }}
      width={520}
      bodyClassName="p-4"
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5 text-[12px] font-medium text-text-2">
          {labels.repository}
          <Select
            value={effectiveRepoKey}
            options={repoOptions}
            onChange={(value) => setRepoKey(String(value))}
            showSearch
            size="small"
            panelZIndex={10001}
            dropdownWidthMode="match"
          />
        </label>
        <Input
          value={title}
          onChange={(value) => setTitle(value)}
          placeholder={labels.issueTitlePlaceholder}
          size="default"
        />
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          className="bg-surface-0 focus:border-accent-5 min-h-28 w-full resize-none rounded-lg border border-border-2 px-3 py-2 text-[13px] text-text-1 outline-none placeholder:text-text-4"
          placeholder={labels.issueBodyPlaceholder}
        />
      </div>
    </Modal>
  );
}

interface GitHubWorkItemsSurfaceProps {
  scope: Extract<GitHubQueryScope, "issue" | "pr">;
  onDetailViewChange: (open: boolean, onBack: (() => void) | null) => void;
}

const GitHubWorkItemsSurface: React.FC<GitHubWorkItemsSurfaceProps> = ({
  scope,
  onDetailViewChange,
}) => {
  const { t } = useTranslation(["sessions", "common"]);
  const repos = useAtomValue(reposAtom);
  const selectedRepoPath = useAtomValue(selectedRepoPathAtom);
  const [selectedRepo, setSelectedRepo] = useAtom(manageIssuesSelectedRepoAtom);
  const store = useStore();
  const setAddToAgent = useSetAtom(addToAgentAtom);
  const { openTab } = useWorkStationTabs();
  const [repoSources, setRepoSources] = useState<GitHubRepoSource[]>([]);
  const [repoIssueMap, setRepoIssueMap] = useState<
    Record<string, RepoIssueState>
  >({});
  const [repoPrMap, setRepoPrMap] = useState<Record<string, RepoPrState>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [currentPage, setCurrentPage] = useState(
    () => getCachedOpsGitHubView(scope)?.currentPage ?? 1
  );
  const [searchQuery, setSearchQuery] = useState(
    () => getCachedOpsGitHubView(scope)?.searchQuery ?? `is:${scope} is:open`
  );
  const parsedSearchQuery = useMemo(() => {
    const query = parseGitHubSearchQuery(searchQuery);
    query.scope = scope;
    return query;
  }, [scope, searchQuery]);
  const selectedIssueListStates = useMemo(
    () => getIssuePageStatesForQuery(parsedSearchQuery),
    [parsedSearchQuery]
  );
  const selectedPrListStates = useMemo(
    () => getOpsPrListStates(parsedSearchQuery.state),
    [parsedSearchQuery.state]
  );
  const [createFormOpen, setCreateFormOpen] = useState(false);
  const [creatingIssue, setCreatingIssue] = useState(false);
  const [issueDetail, setIssueDetail] = useState<IssueDetailState | null>(null);
  const detailViewOpen = Boolean(issueDetail);

  const handleBackFromDetail = useCallback(() => {
    setIssueDetail(null);
  }, []);

  useEffect(() => {
    onDetailViewChange(
      detailViewOpen,
      detailViewOpen ? handleBackFromDetail : null
    );
  }, [detailViewOpen, handleBackFromDetail, onDetailViewChange]);

  useEffect(
    () => () => {
      onDetailViewChange(false, null);
    },
    [onDetailViewChange]
  );
  const previousScopeRef = useRef(scope);
  const handledRefreshNonceRef = useRef(0);

  const gitRepos = useMemo(
    () => repos.filter((repo) => repo.kind === REPO_KIND.GIT && repo.path),
    [repos]
  );

  useEffect(() => {
    if (previousScopeRef.current !== scope) {
      previousScopeRef.current = scope;
      const cachedView = getCachedOpsGitHubView(scope);
      setSearchQuery(cachedView?.searchQuery ?? `is:${scope} is:open`);
      setCurrentPage(cachedView?.currentPage ?? 1);
    }
    setIssueDetail(null);
  }, [scope]);

  useEffect(() => {
    setCachedOpsGitHubView(scope, { searchQuery, currentPage });
  }, [currentPage, scope, searchQuery]);

  useEffect(() => {
    let cancelled = false;
    const forceRefresh = refreshNonce !== handledRefreshNonceRef.current;
    handledRefreshNonceRef.current = refreshNonce;

    void (async () => {
      setLoading(true);
      setLoadError(null);

      const resolvedSources = (
        await Promise.all(gitRepos.map((repo) => resolveGitHubRepoSource(repo)))
      ).filter((source): source is GitHubRepoSource => Boolean(source));

      if (cancelled) return;

      setRepoSources(resolvedSources);
      setRepoIssueMap(
        scope === GITHUB_QUERY_SCOPE.ISSUE
          ? Object.fromEntries(
              resolvedSources.map((source) => [
                getRepoIssueMapKey(source),
                getCachedRepoIssues(source),
              ])
            )
          : {}
      );
      setRepoPrMap(
        scope === GITHUB_QUERY_SCOPE.PR
          ? Object.fromEntries(
              resolvedSources.map((source) => [
                getRepoIssueMapKey(source),
                getCachedRepoPrs(source),
              ])
            )
          : {}
      );

      if (resolvedSources.length === 0) {
        setLoading(false);
        return;
      }

      const [issueResults, prResults] = await Promise.all([
        scope === GITHUB_QUERY_SCOPE.ISSUE
          ? Promise.all(
              resolvedSources.map((source) =>
                loadRepoIssues(source, selectedIssueListStates, forceRefresh)
              )
            )
          : Promise.resolve([]),
        scope === GITHUB_QUERY_SCOPE.PR
          ? Promise.all(
              resolvedSources.flatMap((source) =>
                selectedPrListStates.map((state) =>
                  loadRepoPrs(source, state, forceRefresh)
                )
              )
            )
          : Promise.resolve([]),
      ]);
      if (cancelled) return;

      if (scope === GITHUB_QUERY_SCOPE.ISSUE) {
        setRepoIssueMap(
          Object.fromEntries(
            issueResults.map((result) => [
              getRepoIssueMapKey(result.source),
              {
                openIssues: result.openIssues,
                closedIssues: result.closedIssues,
                openLoaded: result.openLoaded,
                closedLoaded: result.closedLoaded,
                openHasMore: result.openHasMore,
                closedHasMore: result.closedHasMore,
                openNextPage: result.openNextPage,
                closedNextPage: result.closedNextPage,
              },
            ])
          )
        );
      } else {
        setRepoPrMap((current) => {
          const next = { ...current };
          for (const result of prResults) {
            const key = getRepoIssueMapKey(result.source);
            const currentState = next[key] ?? EMPTY_REPO_PRS;
            next[key] =
              result.state === "open"
                ? {
                    ...currentState,
                    openPrs: result.prs,
                    openLoaded: result.loaded,
                    openError: result.error,
                  }
                : {
                    ...currentState,
                    closedPrs: result.prs,
                    closedLoaded: result.loaded,
                    closedError: result.error,
                  };
          }
          return next;
        });
      }
      setLoadError(
        issueResults.find((result) => result.error)?.error ??
          prResults.find((result) => result.error)?.error ??
          null
      );
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    gitRepos,
    refreshNonce,
    scope,
    selectedIssueListStates,
    selectedPrListStates,
  ]);

  const selectedWorkstationRepoSource = useMemo(
    () =>
      repoSources.find((source) => source.repoPath === selectedRepoPath) ??
      null,
    [repoSources, selectedRepoPath]
  );

  const effectiveSelectedRepo =
    selectedRepo === ISSUE_REPO_FILTER.CURRENT_WORKSTATION
      ? (selectedWorkstationRepoSource?.repoFullName ?? ISSUE_REPO_FILTER.ALL)
      : selectedRepo === ISSUE_REPO_FILTER.ALL ||
          repoSources.some((source) => source.repoFullName === selectedRepo)
        ? selectedRepo
        : (selectedWorkstationRepoSource?.repoFullName ??
          ISSUE_REPO_FILTER.ALL);

  const selectedRepoSourceForCreate = useMemo(
    () =>
      effectiveSelectedRepo === ISSUE_REPO_FILTER.ALL
        ? selectedWorkstationRepoSource
        : (repoSources.find(
            (source) => source.repoFullName === effectiveSelectedRepo
          ) ?? null),
    [effectiveSelectedRepo, repoSources, selectedWorkstationRepoSource]
  );

  const updateSearchQuery = useCallback(
    (mutate: (query: ParsedGitHubSearchQuery) => void) => {
      const nextQuery = parseGitHubSearchQuery(searchQuery);
      mutate(nextQuery);
      setSearchQuery(serializeGitHubSearchQuery(nextQuery));
      setCurrentPage(1);
    },
    [searchQuery]
  );

  const handleSearchQueryChange = useCallback((query: string) => {
    setSearchQuery(query);
    setCurrentPage(1);
  }, []);

  const handleRepoSelect = useCallback(
    (repo: IssueRepoFilter) => {
      setSelectedRepo(repo);
      setCurrentPage(1);
    },
    [setSelectedRepo]
  );

  const handleIssuePersonalFiltersSelect = useCallback(
    (values: (string | number)[]) => {
      updateSearchQuery((query) => {
        query.author = values.includes(GITHUB_FILTER_PRESET.BY_ME)
          ? "@me"
          : null;
        query.assignee = values.includes(GITHUB_FILTER_PRESET.ASSIGNED_TO_ME)
          ? "@me"
          : null;
      });
    },
    [updateSearchQuery]
  );

  const issuePersonalFilterOptions = useMemo<SelectOption[]>(
    () =>
      scope === GITHUB_QUERY_SCOPE.ISSUE
        ? [
            {
              value: GITHUB_FILTER_PRESET.BY_ME,
              label: t("chat.panels.manageIssues.createdByMe"),
            },
            {
              value: GITHUB_FILTER_PRESET.ASSIGNED_TO_ME,
              label: t("chat.panels.manageIssues.assignedToMe"),
            },
          ]
        : [],
    [scope, t]
  );

  const selectedIssuePersonalFilters = useMemo(
    () => [
      ...(parsedSearchQuery.author === "@me"
        ? [GITHUB_FILTER_PRESET.BY_ME]
        : []),
      ...(parsedSearchQuery.assignee === "@me"
        ? [GITHUB_FILTER_PRESET.ASSIGNED_TO_ME]
        : []),
    ],
    [parsedSearchQuery.assignee, parsedSearchQuery.author]
  );

  const repoOptions = useMemo<RepoFilterOption[]>(
    () => [
      {
        key: ISSUE_REPO_FILTER.ALL,
        label: t("chat.manageIssues.allRepositories"),
      },
      ...repoSources.map((source) => ({
        key: source.repoFullName,
        label: source.repoFullName,
      })),
    ],
    [repoSources, t]
  );

  const issues = useMemo(
    () =>
      repoSources.flatMap((source) => {
        const sourceIssues =
          repoIssueMap[getRepoIssueMapKey(source)] ?? EMPTY_REPO_ISSUES;
        return [...sourceIssues.openIssues, ...sourceIssues.closedIssues].map(
          (issue) => mapIssueToManagedIssue(issue, source)
        );
      }),
    [repoIssueMap, repoSources]
  );

  const pullRequests = useMemo(
    () =>
      repoSources.flatMap((source) => {
        const sourcePrs =
          repoPrMap[getRepoIssueMapKey(source)] ?? EMPTY_REPO_PRS;
        return [...sourcePrs.openPrs, ...sourcePrs.closedPrs].map((pr) =>
          mapPrToManagedPr(pr, source)
        );
      }),
    [repoPrMap, repoSources]
  );

  const allItems = useMemo(
    () =>
      [...issues, ...pullRequests].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt)
      ),
    [issues, pullRequests]
  );

  const filteredItems = useMemo(
    () =>
      allItems.filter((item) => {
        if (!itemMatchesRepo(item, effectiveSelectedRepo)) return false;
        return itemMatchesParsedQuery(item, parsedSearchQuery);
      }),
    [allItems, effectiveSelectedRepo, parsedSearchQuery]
  );

  const pageStates = useMemo(
    () => getIssuePageStatesForQuery(parsedSearchQuery),
    [parsedSearchQuery]
  );
  const paginatedSources = useMemo(
    () =>
      effectiveSelectedRepo === ISSUE_REPO_FILTER.ALL
        ? repoSources
        : repoSources.filter(
            (source) => source.repoFullName === effectiveSelectedRepo
          ),
    [effectiveSelectedRepo, repoSources]
  );
  const hasMoreFilteredIssues = useMemo(
    () =>
      paginatedSources.some((source) => {
        const state = repoIssueMap[getRepoIssueMapKey(source)];
        if (!state) return false;
        return pageStates.some((pageState) =>
          pageState === "open" ? state.openHasMore : state.closedHasMore
        );
      }),
    [pageStates, paginatedSources, repoIssueMap]
  );
  const totalLoadedPages = getGitHubWorkItemsPageCount(filteredItems.length);
  const pagedItems = useMemo(
    () => getGitHubWorkItemsPage(filteredItems, currentPage),
    [currentPage, filteredItems]
  );
  const issueStateCounts = useMemo(
    () =>
      issues.reduce(
        (counts, issue) => {
          if (!itemMatchesRepo(issue, effectiveSelectedRepo)) return counts;
          counts[issue.state] += 1;
          return counts;
        },
        { open: 0, closed: 0 }
      ),
    [effectiveSelectedRepo, issues]
  );
  const openIssuesLoaded = useMemo(
    () =>
      paginatedSources.length > 0 &&
      paginatedSources.every(
        (source) =>
          repoIssueMap[getRepoIssueMapKey(source)]?.openLoaded === true
      ),
    [paginatedSources, repoIssueMap]
  );
  const closedIssuesLoaded = useMemo(
    () =>
      paginatedSources.length > 0 &&
      paginatedSources.every(
        (source) =>
          repoIssueMap[getRepoIssueMapKey(source)]?.closedLoaded === true
      ),
    [paginatedSources, repoIssueMap]
  );
  const openPrCount = useMemo(
    () =>
      pullRequests.filter(
        (pr) =>
          pr.state === GITHUB_QUERY_STATE.OPEN &&
          itemMatchesRepo(pr, effectiveSelectedRepo)
      ).length,
    [effectiveSelectedRepo, pullRequests]
  );
  const openPrLoaded = useMemo(
    () =>
      paginatedSources.length > 0 &&
      paginatedSources.every(
        (source) => repoPrMap[getRepoIssueMapKey(source)]?.openLoaded === true
      ),
    [paginatedSources, repoPrMap]
  );
  const closedPrCount = useMemo(
    () =>
      pullRequests.filter(
        (pr) =>
          (pr.state === GITHUB_QUERY_STATE.CLOSED ||
            pr.state === GITHUB_QUERY_STATE.MERGED) &&
          itemMatchesRepo(pr, effectiveSelectedRepo)
      ).length,
    [effectiveSelectedRepo, pullRequests]
  );
  const closedPrLoaded = useMemo(
    () =>
      paginatedSources.length > 0 &&
      paginatedSources.every(
        (source) => repoPrMap[getRepoIssueMapKey(source)]?.closedLoaded === true
      ),
    [paginatedSources, repoPrMap]
  );

  useEffect(() => {
    if (!loading && currentPage > totalLoadedPages) {
      setCurrentPage(totalLoadedPages);
    }
  }, [currentPage, loading, totalLoadedPages]);

  const listScrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual exposes imperative helpers that cannot be memoized safely.
  const itemVirtualizer = useVirtualizer({
    count: pagedItems.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => (scope === GITHUB_QUERY_SCOPE.ISSUE ? 72 : 82),
    overscan: 8,
  });
  const virtualItems = itemVirtualizer.getVirtualItems();

  const handleBackToIssueList = handleBackFromDetail;

  const surfaceTitle =
    scope === GITHUB_QUERY_SCOPE.PR
      ? t("sessions:kanban.sidebar.githubPrs")
      : t("sessions:kanban.sidebar.githubIssues");

  const headerContent = useMemo(
    () => (
      <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-text-1">
        {issueDetail ? (
          <IssueDetailHeaderContent issue={issueDetail.issue} />
        ) : (
          surfaceTitle
        )}
      </span>
    ),
    [issueDetail, surfaceTitle]
  );

  const handleRefresh = useCallback(() => {
    setCurrentPage(1);
    setRefreshNonce((current) => current + 1);
  }, []);

  const handleLoadMore = useCallback(async () => {
    if (loadingMore || !hasMoreFilteredIssues) return;
    setLoadingMore(true);

    const requests = paginatedSources.flatMap((source) => {
      const repoIssueState = repoIssueMap[getRepoIssueMapKey(source)];
      if (!repoIssueState) return [];

      return pageStates.flatMap((pageState) => {
        const hasMore =
          pageState === "open"
            ? repoIssueState.openHasMore
            : repoIssueState.closedHasMore;
        const nextPage =
          pageState === "open"
            ? repoIssueState.openNextPage
            : repoIssueState.closedNextPage;
        if (!hasMore || !nextPage) return [];

        return [{ source, pageState, nextPage }];
      });
    });

    const results = await Promise.all(
      requests.map(async ({ source, pageState, nextPage }) => ({
        source,
        pageState,
        result: await fetchIssues(source.remoteUrl, {
          state: pageState,
          page: nextPage,
          perPage: ISSUE_PAGE_SIZE,
        }),
      }))
    );

    setRepoIssueMap((current) => {
      const next = { ...current };
      for (const { source, pageState, result } of results) {
        if (!result.data) continue;
        const key = getRepoIssueMapKey(source);
        const currentState = next[key] ?? EMPTY_REPO_ISSUES;
        if (pageState === "open") {
          const openIssues = mergeUniqueIssues(
            currentState.openIssues,
            result.data.issues
          );
          next[key] = {
            ...currentState,
            openIssues,
            openHasMore: result.data.has_more,
            openNextPage: result.data.next_page,
          };
          updateCachedOpenIssues(source.repoPath, openIssues);
        } else {
          const closedIssues = mergeUniqueIssues(
            currentState.closedIssues,
            result.data.issues
          );
          next[key] = {
            ...currentState,
            closedIssues,
            closedHasMore: result.data.has_more,
            closedNextPage: result.data.next_page,
          };
          updateCachedClosedIssues(source.repoPath, closedIssues);
        }
      }
      return next;
    });
    setLoadError(
      results.find(({ result }) => result.error)?.result.error ?? null
    );
    setLoadingMore(false);
  }, [
    hasMoreFilteredIssues,
    loadingMore,
    pageStates,
    paginatedSources,
    repoIssueMap,
  ]);

  const handlePreviousPage = useCallback(() => {
    setCurrentPage((page) => Math.max(1, page - 1));
    listScrollRef.current?.scrollTo({ top: 0 });
  }, []);

  const handleNextPage = useCallback(async () => {
    if (currentPage < totalLoadedPages) {
      setCurrentPage((page) => page + 1);
      listScrollRef.current?.scrollTo({ top: 0 });
      return;
    }
    if (!hasMoreFilteredIssues || loadingMore) return;

    await handleLoadMore();
    setCurrentPage((page) => page + 1);
    listScrollRef.current?.scrollTo({ top: 0 });
  }, [
    currentPage,
    handleLoadMore,
    hasMoreFilteredIssues,
    loadingMore,
    totalLoadedPages,
  ]);

  const handleOpenIssue = useCallback((issue: ManagedIssueItem) => {
    setIssueDetail({
      source: issue,
      issue: issue.rawIssue,
      comments: [],
      commentsLoading: true,
      submittingComment: false,
      error: null,
    });

    void (async () => {
      const result = await fetchIssueComments({
        remoteUrl: issue.remoteUrl,
        issueNumber: issue.id,
      });
      setIssueDetail((current) => {
        if (current?.issue.html_url !== issue.rawIssue.html_url) {
          return current;
        }
        return {
          ...current,
          comments: result.data ?? [],
          commentsLoading: false,
          error: result.error ?? null,
        };
      });
    })();
  }, []);

  const handleOpenIssueInBrowser = useCallback((issue: ManagedIssueItem) => {
    void openExternalLink(issue.rawIssue.html_url);
  }, []);

  const handleOpenIssueInMyStation = useCallback(
    (issue: ManagedIssueItem) => {
      const selectedIssueAtom = workstationSelectedIssueAtomFamily(
        workstationRepoScopeKey(undefined, issue.repoPath)
      );
      store.set(selectedIssueAtom, {
        issue: issue.rawIssue,
        comments: [],
        loading: false,
        commentsLoading: true,
        error: null,
        submittingComment: false,
      });
      openTab(
        createGitHubIssueDetailTab(
          issue.id,
          issue.title,
          issue.repoPath,
          issue.remoteUrl
        )
      );

      void (async () => {
        const result = await fetchIssueComments({
          remoteUrl: issue.remoteUrl,
          issueNumber: issue.id,
        });
        store.set(selectedIssueAtom, (current) => {
          if (current.issue?.html_url !== issue.rawIssue.html_url) {
            return current;
          }
          return {
            ...current,
            comments: result.data ?? [],
            commentsLoading: false,
            error: result.error ?? null,
          };
        });
      })();
    },
    [openTab, store]
  );

  const handleCloseIssueDetail = useCallback(async () => {
    const currentIssue = issueDetail;
    if (!currentIssue) return;
    const result = await closeIssue({
      remoteUrl: currentIssue.source.remoteUrl,
      issueNumber: currentIssue.issue.number,
    });
    setIssueDetail((current) => {
      if (!current || current.issue.html_url !== currentIssue.issue.html_url) {
        return current;
      }
      if (result.data) {
        return { ...current, issue: result.data, error: null };
      }
      return { ...current, error: result.error };
    });
  }, [issueDetail]);

  const handleReopenIssueDetail = useCallback(async () => {
    const currentIssue = issueDetail;
    if (!currentIssue) return;
    const result = await reopenIssue({
      remoteUrl: currentIssue.source.remoteUrl,
      issueNumber: currentIssue.issue.number,
    });
    setIssueDetail((current) => {
      if (!current || current.issue.html_url !== currentIssue.issue.html_url) {
        return current;
      }
      if (result.data) {
        return { ...current, issue: result.data, error: null };
      }
      return { ...current, error: result.error };
    });
  }, [issueDetail]);

  const handleAddIssueDetailComment = useCallback(
    async (body: string) => {
      const currentIssue = issueDetail;
      if (!currentIssue) return;
      setIssueDetail((current) =>
        current?.issue.html_url === currentIssue.issue.html_url
          ? { ...current, submittingComment: true }
          : current
      );
      const result = await addIssueComment({
        remoteUrl: currentIssue.source.remoteUrl,
        issueNumber: currentIssue.issue.number,
        body,
      });
      if (result.data) {
        const comment = result.data;
        setIssueDetail((current) =>
          current?.issue.html_url === currentIssue.issue.html_url
            ? {
                ...current,
                issue: {
                  ...current.issue,
                  comments: current.issue.comments + 1,
                },
                comments: [...current.comments, comment],
                submittingComment: false,
                error: null,
              }
            : current
        );
        return;
      }
      setIssueDetail((current) =>
        current?.issue.html_url === currentIssue.issue.html_url
          ? { ...current, submittingComment: false, error: result.error }
          : current
      );
      throw new Error(result.error);
    },
    [issueDetail]
  );

  const handleAddIssue = useCallback(
    (issue: ManagedIssueItem) => {
      setAddToAgent({
        type: "issue",
        issueNumber: issue.id,
        issueTitle: issue.title,
        issueUrl: issue.rawIssue.html_url,
        issueState: issue.state,
        labels: issue.labels.map((label) => label.name),
        assignees: issue.rawIssue.assignees.map((assignee) => assignee.login),
        comments: issue.comments,
      });
      Message.success(t("toasts.addedAsContext", { name: `#${issue.id}` }));
    },
    [setAddToAgent, t]
  );

  const handleAddPr = useCallback(
    (pr: ManagedPrItem) => {
      setAddToAgent({
        type: "pr",
        prNumber: pr.id,
        prTitle: pr.title,
        prUrl: pr.rawPr.url,
        prStatus: pr.state,
        sourceBranch: pr.sourceBranch,
        targetBranch: pr.targetBranch,
      });
      Message.success(t("toasts.addedAsContext", { name: `PR #${pr.id}` }));
    },
    [setAddToAgent, t]
  );

  const handleOpenPr = useCallback(
    (pr: ManagedPrItem) => {
      openTab(
        createGitHubPrDetailTab({
          prNumber: pr.id,
          prTitle: pr.title,
          prUrl: pr.rawPr.url,
          prStatus: pr.state,
          headBranch: pr.sourceBranch,
          baseBranch: pr.targetBranch,
          repoPath: pr.repoPath,
          repoId: pr.repoId,
        })
      );
      void WorkStationViewService.openStationMode("my-station");
    },
    [openTab]
  );

  const headerContribution = useMemo(
    () => ({ content: headerContent }),
    [headerContent]
  );

  usePublishWorkstationTabHeader({
    host: "workManagement",
    content: headerContribution,
  });

  const handleCreateIssue = useCallback(
    async (source: GitHubRepoSource, title: string, body: string) => {
      setCreatingIssue(true);
      const result = await createIssue({
        remoteUrl: source.remoteUrl,
        title,
        body: body || undefined,
      });
      setCreatingIssue(false);

      if (result.error || !result.data) {
        Message.error(
          result.error ?? t("chat.panels.manageIssues.createIssueFailed")
        );
        return;
      }
      const createdIssue = result.data;

      setRepoIssueMap((current) => {
        const key = getRepoIssueMapKey(source);
        const currentState = current[key] ?? EMPTY_REPO_ISSUES;
        const openIssues = mergeUniqueIssues(
          [createdIssue],
          currentState.openIssues
        );
        updateCachedOpenIssues(source.repoPath, openIssues);
        return {
          ...current,
          [key]: {
            ...currentState,
            openIssues,
          },
        };
      });
      setCreateFormOpen(false);
      Message.success(
        t("toasts.addedAsContext", { name: `#${createdIssue.number}` })
      );
      setAddToAgent({
        type: "issue",
        issueNumber: createdIssue.number,
        issueTitle: createdIssue.title,
        issueUrl: createdIssue.html_url,
        issueState: createdIssue.state,
        labels: createdIssue.labels.map((label) => label.name),
        assignees: createdIssue.assignees.map((assignee) => assignee.login),
        comments: createdIssue.comments,
      });
    },
    [setAddToAgent, t]
  );

  const listContent = (() => {
    if (
      scope !== GITHUB_QUERY_SCOPE.PR &&
      loading &&
      filteredItems.length === 0
    ) {
      return (
        <Placeholder
          variant="loading"
          placement="detail-panel"
          fillParentHeight
        />
      );
    }

    if (loadError && allItems.length === 0) {
      return (
        <Placeholder
          variant="error"
          subtitle={loadError}
          action={{ label: t("common:actions.retry"), onClick: handleRefresh }}
          fillParentHeight
        />
      );
    }

    if (!loading && repoSources.length === 0) {
      return <Placeholder variant="empty" fillParentHeight />;
    }

    if (
      scope !== GITHUB_QUERY_SCOPE.PR &&
      !loading &&
      filteredItems.length === 0
    ) {
      return <Placeholder variant="no-results" fillParentHeight />;
    }

    const summary = (
      <GitHubWorkItemSummary
        tabs={
          scope === GITHUB_QUERY_SCOPE.ISSUE
            ? [
                {
                  key: GITHUB_QUERY_STATE.OPEN,
                  label: t("chat.panels.manageIssues.stateOpen"),
                  count: openIssuesLoaded ? issueStateCounts.open : null,
                  icon: <CircleDot size={13} strokeWidth={1.8} />,
                  active: parsedSearchQuery.state === GITHUB_QUERY_STATE.OPEN,
                  onSelect: () =>
                    updateSearchQuery((query) => {
                      query.state = GITHUB_QUERY_STATE.OPEN;
                    }),
                },
                {
                  key: GITHUB_QUERY_STATE.CLOSED,
                  label: t("chat.panels.manageIssues.stateClosed"),
                  count: closedIssuesLoaded ? issueStateCounts.closed : null,
                  icon: <CheckCircle2 size={13} strokeWidth={1.8} />,
                  active: parsedSearchQuery.state === GITHUB_QUERY_STATE.CLOSED,
                  onSelect: () =>
                    updateSearchQuery((query) => {
                      query.state = GITHUB_QUERY_STATE.CLOSED;
                    }),
                },
              ]
            : [
                {
                  key: GITHUB_QUERY_STATE.OPEN,
                  label: t("chat.panels.manageIssues.stateOpen"),
                  count: openPrLoaded ? openPrCount : null,
                  icon: <GitPullRequest size={13} strokeWidth={1.8} />,
                  active:
                    parsedSearchQuery.state === null ||
                    parsedSearchQuery.state === GITHUB_QUERY_STATE.OPEN,
                  onSelect: () =>
                    updateSearchQuery((query) => {
                      query.state = GITHUB_QUERY_STATE.OPEN;
                    }),
                },
                {
                  key: GITHUB_QUERY_STATE.CLOSED,
                  label: t("chat.panels.manageIssues.stateClosed"),
                  count: closedPrLoaded ? closedPrCount : null,
                  icon: <CheckCircle2 size={13} strokeWidth={1.8} />,
                  active:
                    parsedSearchQuery.state === GITHUB_QUERY_STATE.CLOSED ||
                    parsedSearchQuery.state === GITHUB_QUERY_STATE.MERGED,
                  onSelect: () =>
                    updateSearchQuery((query) => {
                      query.state = GITHUB_QUERY_STATE.CLOSED;
                    }),
                },
              ]
        }
        actions={
          scope === GITHUB_QUERY_SCOPE.ISSUE ? (
            <Dropdown
              options={issuePersonalFilterOptions}
              value={selectedIssuePersonalFilters}
              mode="multiple"
              position="bottom-end"
              onSelect={(value) =>
                handleIssuePersonalFiltersSelect(
                  Array.isArray(value) ? value : [value]
                )
              }
            >
              <Button
                htmlType="button"
                variant="secondary"
                appearance="outline"
                size="small"
              >
                {t("common:actions.filter")}
                {selectedIssuePersonalFilters.length > 0
                  ? ` (${selectedIssuePersonalFilters.length})`
                  : ""}
              </Button>
            </Dropdown>
          ) : undefined
        }
      />
    );

    return (
      <GitHubWorkItemListFrame
        summary={summary}
        height={
          scope === GITHUB_QUERY_SCOPE.PR && filteredItems.length === 0
            ? 180
            : itemVirtualizer.getTotalSize()
        }
      >
        {scope === GITHUB_QUERY_SCOPE.PR && filteredItems.length === 0 ? (
          <Placeholder
            variant={loading ? "loading" : loadError ? "error" : "no-results"}
            subtitle={loadError ?? undefined}
            action={
              loadError
                ? {
                    label: t("common:actions.retry"),
                    onClick: handleRefresh,
                  }
                : undefined
            }
            fillParentHeight
          />
        ) : (
          virtualItems.map((virtualItem) => {
            const item = pagedItems[virtualItem.index];
            return (
              <div
                key={`${item.kind}-${item.repo}-${item.id}`}
                ref={itemVirtualizer.measureElement}
                data-index={virtualItem.index}
                className={`absolute left-0 top-0 w-full ${
                  virtualItem.index < pagedItems.length - 1
                    ? "border-b border-border-2"
                    : ""
                }`}
                style={{ transform: `translateY(${virtualItem.start}px)` }}
              >
                {item.kind === GITHUB_ITEM_KIND.ISSUE ? (
                  <ManagedIssueRow
                    issue={item}
                    addLabel={t("chat.panels.manageIssues.addToChat")}
                    openInBrowserLabel={t("common:previews.openInBrowser")}
                    openInMyStationLabel={t("layout.sidebar.openInMyStation")}
                    moreActionsLabel={t("common:actions.moreActions")}
                    onOpenIssue={handleOpenIssue}
                    onOpenIssueInBrowser={handleOpenIssueInBrowser}
                    onOpenIssueInMyStation={handleOpenIssueInMyStation}
                    onAddIssue={handleAddIssue}
                  />
                ) : (
                  <ManagedPrRow
                    pr={item}
                    addLabel={t("chat.panels.manageIssues.addToChat")}
                    onOpenPr={handleOpenPr}
                    onAddPr={handleAddPr}
                  />
                )}
              </div>
            );
          })
        )}
      </GitHubWorkItemListFrame>
    );
  })();

  const issueDetailContent = issueDetail ? (
    <IssueDetailPanel
      issue={issueDetail.issue}
      comments={issueDetail.comments}
      commentsLoading={issueDetail.commentsLoading}
      submittingComment={issueDetail.submittingComment}
      showHeader={false}
      contentPadding="default"
      onClose={handleBackToIssueList}
      onCloseIssue={handleCloseIssueDetail}
      onReopenIssue={handleReopenIssueDetail}
      onAddComment={handleAddIssueDetailComment}
    />
  ) : null;

  const listDescriptionContent = (
    <section
      className="flex min-h-0 flex-1"
      data-testid={`work-management-github-${scope}`}
    >
      <CreateIssueModal
        open={createFormOpen}
        repoSources={repoSources}
        selectedRepo={selectedRepoSourceForCreate}
        creating={creatingIssue}
        labels={{
          title: t("chat.panels.manageIssues.newIssueTitle"),
          issueTitlePlaceholder: t(
            "chat.panels.manageIssues.issueTitlePlaceholder"
          ),
          issueBodyPlaceholder: t(
            "chat.panels.manageIssues.issueBodyPlaceholder"
          ),
          repository: t("chat.panels.manageIssues.repositoryLabel"),
          cancel: t("common:actions.cancel"),
          create: t("chat.panels.manageIssues.createIssue"),
          creating: t("chat.panels.manageIssues.creatingIssue"),
        }}
        onCreateIssue={handleCreateIssue}
        onCancel={() => setCreateFormOpen(false)}
      />
      <div className="bg-bg-0 flex min-w-0 flex-1 flex-col">
        {issueDetailContent ?? (
          <>
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border-2 px-3">
              <RepoFilterPill
                options={repoOptions}
                selectedRepo={effectiveSelectedRepo}
                allReposLabel={t("chat.manageIssues.allRepositories")}
                onSelectRepo={handleRepoSelect}
              />
              <SearchInput
                value={searchQuery}
                onChange={handleSearchQueryChange}
                placeholder={t("chat.panels.manageIssues.searchPlaceholder")}
                variant="panel"
                surface="pane"
                hideChevron
                showClearButton
                inputBoxClassName="flex-1"
                className="min-w-0 flex-1"
              />
              <GitHubWorkItemToolbarActions
                openHref={
                  selectedRepoSourceForCreate
                    ? `https://github.com/${selectedRepoSourceForCreate.repoFullName}`
                    : null
                }
                openLabel={t("chat.panels.manageIssues.openInGitHub")}
                refreshLabel={t("common:actions.refresh")}
                refreshing={loading}
                createAction={
                  scope === GITHUB_QUERY_SCOPE.ISSUE
                    ? {
                        label: t("chat.panels.manageIssues.createIssueTrigger"),
                        disabled: repoSources.length === 0,
                        onClick: () => setCreateFormOpen(true),
                      }
                    : undefined
                }
                onRefresh={handleRefresh}
              />
            </div>
            <div
              ref={listScrollRef}
              className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-hide"
            >
              {listContent}
            </div>
            {filteredItems.length > 0 ? (
              <GitHubWorkItemPagination
                totalLabel={t("common:pagination.pageOf", {
                  current: currentPage,
                  total: hasMoreFilteredIssues
                    ? `${totalLoadedPages}+`
                    : totalLoadedPages,
                })}
                previousLabel={t("common:actions.previous")}
                nextLabel={t("common:actions.next")}
                loadingNext={loadingMore}
                canGoPrevious={currentPage > 1}
                canGoNext={canAdvanceGitHubWorkItemsPage({
                  currentPage,
                  loadedPageCount: totalLoadedPages,
                  hasMoreRemoteItems: hasMoreFilteredIssues,
                })}
                onPrevious={handlePreviousPage}
                onNext={() => void handleNextPage()}
              />
            ) : null}
          </>
        )}
      </div>
    </section>
  );

  return (
    <>
      <div
        className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
        data-testid="work-management-github"
      >
        <DetailPanelContainer testId="work-management-github-panel">
          {listDescriptionContent}
        </DetailPanelContainer>
      </div>
    </>
  );
};

export default GitHubWorkItemsSurface;

import { useVirtualizer } from "@tanstack/react-virtual";
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import {
  CheckCircle2,
  CircleDot,
  ExternalLink,
  GitPullRequest,
  Link2,
  ListFilter,
  MoreHorizontal,
  Plus,
  RefreshCw,
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
  listOpenPRsLocal,
} from "@src/api/tauri/github";
import type {
  GitHubIssue,
  GitHubIssueComment,
  OpenPRItem,
} from "@src/api/tauri/github";
import Button from "@src/components/Button";
import Dropdown from "@src/components/Dropdown";
import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import Input from "@src/components/Input";
import Message from "@src/components/Message";
import { SearchInput } from "@src/components/SearchInput";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import TabPill from "@src/components/TabPill";
import type { TabPillItem } from "@src/components/TabPill";
import {
  ChatPanelHeaderTitlePill,
  usePublishChatPanelHeader,
} from "@src/engines/ChatPanel/header";
import { useWorkStationTabs } from "@src/hooks/workStation/tabs";
import WorkItemContentStack from "@src/modules/ProjectManager/WorkItems/components/WorkItemContentStack";
import {
  IssueDetailHeaderContent,
  IssueDetailPanel,
  IssueStateIcon,
  getIssueDetailTitle,
} from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/IssuesContent/IssueDetailPanel";
import {
  getCachedIssues,
  isIssueCacheStale,
  updateCachedClosedIssues,
  updateCachedOpenIssues,
} from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/hooks/githubListCache";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  Placeholder,
} from "@src/modules/shared/layouts/blocks";
import Modal from "@src/scaffold/ModalSystem";
import { parseGithubRepoFullName } from "@src/services/git/operations/createPullRequest";
import {
  addIssueComment,
  closeIssue,
  createIssue,
  fetchIssueComments,
  fetchIssues,
  reopenIssue,
} from "@src/services/git/operations/githubIssues";
import { REPO_KIND, reposAtom, selectedRepoPathAtom } from "@src/store/repo";
import type { Repo } from "@src/store/repo/types";
import { addToAgentAtom } from "@src/store/ui/addToAgentAtom";
import { workstationSelectedIssueAtomFamily } from "@src/store/workstation/codeEditor/workstationIssueAtom";
import { workstationRepoScopeKey } from "@src/store/workstation/codeEditor/workstationPrAtom";
import { createGitHubIssueDetailTab } from "@src/store/workstation/tabs";
import { openExternalLink } from "@src/util/platform/ipcRenderer";

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
  OPEN: "open",
  ASSIGNED_TO_ME: "assignedToMe",
  BY_ME: "byMe",
  CLOSED: "closed",
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
  "orgii:chatPanelManageIssues:selectedRepo:v2",
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

interface ChatIssueDetailState {
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
  openHasMore: boolean;
  closedHasMore: boolean;
  openNextPage: number | null;
  closedNextPage: number | null;
}

interface RepoPrState {
  prs: OpenPRItem[];
  error: string | null;
}

interface RepoIssueLoadResult {
  source: GitHubRepoSource;
  openIssues: GitHubIssue[];
  closedIssues: GitHubIssue[];
  openHasMore: boolean;
  closedHasMore: boolean;
  openNextPage: number | null;
  closedNextPage: number | null;
  error: string | null;
}

interface RepoPrLoadResult {
  source: GitHubRepoSource;
  prs: OpenPRItem[];
  error: string | null;
}

const EMPTY_REPO_ISSUES: RepoIssueState = {
  openIssues: [],
  closedIssues: [],
  openHasMore: false,
  closedHasMore: false,
  openNextPage: null,
  closedNextPage: null,
};

const EMPTY_REPO_PRS: RepoPrState = {
  prs: [],
  error: null,
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
    if (query.state === GITHUB_QUERY_STATE.MERGED) return false;
    if (item.state !== query.state) return false;
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
    openHasMore: cached.openIssues.length >= ISSUE_PAGE_SIZE,
    closedHasMore: cached.closedIssues.length >= ISSUE_PAGE_SIZE,
    openNextPage: cached.openIssues.length >= ISSUE_PAGE_SIZE ? 2 : null,
    closedNextPage: cached.closedIssues.length >= ISSUE_PAGE_SIZE ? 2 : null,
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
  source: GitHubRepoSource
): Promise<RepoIssueLoadResult> {
  const cached = getCachedRepoIssues(source);
  if (!isIssueCacheStale(source.repoPath)) {
    return {
      source,
      openIssues: cached.openIssues,
      closedIssues: cached.closedIssues,
      openHasMore: cached.openHasMore,
      closedHasMore: cached.closedHasMore,
      openNextPage: cached.openNextPage,
      closedNextPage: cached.closedNextPage,
      error: null,
    };
  }

  const [openResult, closedResult] = await Promise.all([
    fetchIssues(source.remoteUrl, {
      state: "open",
      page: 1,
      perPage: ISSUE_PAGE_SIZE,
    }),
    fetchIssues(source.remoteUrl, {
      state: "closed",
      page: 1,
      perPage: ISSUE_PAGE_SIZE,
    }),
  ]);

  const openIssues = openResult.data?.issues ?? cached.openIssues;
  const closedIssues = closedResult.data?.issues ?? cached.closedIssues;

  if (openResult.data) updateCachedOpenIssues(source.repoPath, openIssues);
  if (closedResult.data)
    updateCachedClosedIssues(source.repoPath, closedIssues);

  return {
    source,
    openIssues,
    closedIssues,
    openHasMore: openResult.data?.has_more ?? false,
    closedHasMore: closedResult.data?.has_more ?? false,
    openNextPage: openResult.data?.next_page ?? null,
    closedNextPage: closedResult.data?.next_page ?? null,
    error: openResult.error ?? closedResult.error ?? null,
  };
}

async function loadRepoPrs(
  source: GitHubRepoSource
): Promise<RepoPrLoadResult> {
  try {
    return {
      source,
      prs: await listOpenPRsLocal(source.repoFullName, PR_PAGE_SIZE),
      error: null,
    };
  } catch (err: unknown) {
    return {
      source,
      prs: [],
      error: String(err),
    };
  }
}

function FilterMenuButton({
  label,
  options,
  onSelect,
}: {
  label: string;
  options: RepoFilterOption[];
  onSelect: (key: string) => void;
}): React.ReactNode {
  const [menuVisible, setMenuVisible] = useState(false);
  const closeMenu = useCallback(() => setMenuVisible(false), []);
  const droplist = (
    <div className={`${DROPDOWN_CLASSES.menuPanelBase} min-w-[170px]`}>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          className={DROPDOWN_CLASSES.menuActionItem}
          onClick={() => {
            onSelect(option.key);
            closeMenu();
          }}
        >
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
        </button>
      ))}
    </div>
  );

  return (
    <Dropdown
      droplist={droplist}
      trigger="click"
      position="bottom-start"
      popupVisible={menuVisible}
      onVisibleChange={setMenuVisible}
    >
      <Button
        htmlType="button"
        variant="secondary"
        appearance="outline"
        size="small"
        icon={<ListFilter size={13} />}
        iconOnly
        className="h-7 w-7"
        aria-label={label}
        aria-expanded={menuVisible}
      />
    </Dropdown>
  );
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
    <div className="focus-within:ring-accent-5/50 group w-full rounded-xl px-3 py-2 transition-colors focus-within:ring-2 hover:bg-fill-1/60">
      <div className="flex items-start gap-2.5">
        <span className={`mt-0.5 shrink-0 ${stateClassName}`}>
          <ManagedIssueStateIcon state={issue.state} />
        </span>
        <button
          type="button"
          className="min-w-0 flex-1 text-left focus-visible:outline-none"
          onClick={() => onOpenIssue(issue)}
          aria-label={`Open issue #${issue.id}: ${issue.title}`}
        >
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <h3 className="m-0 min-w-0 text-[13px] font-medium leading-5 text-text-1">
              {issue.title} <span className="text-text-3">#{issue.id}</span>
            </h3>
          </div>
          {issue.labels.length > 0 ? (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {issue.labels.map((label) => (
                <IssueLabelTag key={label.name} label={label} />
              ))}
            </div>
          ) : null}
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-text-3">
            <span>{issue.repo}</span>
            <span>·</span>
            <span>{issue.author}</span>
            <span>·</span>
            <span>{issue.timeAgo}</span>
          </div>
        </button>
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
      </div>
    </div>
  );
}

function ManagedPrRow({
  pr,
  addLabel,
  onAddPr,
}: {
  pr: ManagedPrItem;
  addLabel: string;
  onAddPr: (pr: ManagedPrItem) => void;
}): React.ReactNode {
  return (
    <div className="focus-within:ring-accent-5/50 group w-full rounded-xl px-3 py-2 transition-colors focus-within:ring-2 hover:bg-fill-1/60">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-success-6">
          <GitPullRequest size={14} strokeWidth={1.8} />
        </span>
        <a
          className="min-w-0 flex-1 text-left focus-visible:outline-none"
          href={pr.rawPr.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open pull request #${pr.id}: ${pr.title}`}
        >
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <h3 className="m-0 min-w-0 text-[13px] font-medium leading-5 text-text-1">
              {pr.title} <span className="text-text-3">PR #{pr.id}</span>
            </h3>
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-text-3">
            <span>{pr.repo}</span>
            <span>·</span>
            <span>{pr.sourceBranch}</span>
            <span>→</span>
            <span>{pr.targetBranch}</span>
            <span>·</span>
            <span>{pr.timeAgo}</span>
          </div>
        </a>
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
      </div>
    </div>
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

const ManageIssuesPanelView: React.FC = () => {
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
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState("is:issue is:open");
  const parsedSearchQuery = useMemo(
    () => parseGitHubSearchQuery(searchQuery),
    [searchQuery]
  );
  const [createFormOpen, setCreateFormOpen] = useState(false);
  const [creatingIssue, setCreatingIssue] = useState(false);
  const [chatIssueDetail, setChatIssueDetail] =
    useState<ChatIssueDetailState | null>(null);

  const gitRepos = useMemo(
    () => repos.filter((repo) => repo.kind === REPO_KIND.GIT && repo.path),
    [repos]
  );

  const typeSwitchOptions = useMemo<TabPillItem[]>(
    () => [
      {
        key: GITHUB_QUERY_SCOPE.ISSUE,
        label: t("chat.panels.manageIssues.sourceIssues"),
      },
      {
        key: GITHUB_QUERY_SCOPE.PR,
        label: t("chat.panels.manageIssues.sourcePrs"),
      },
    ],
    [t]
  );

  const quickFilterOptions = useMemo<TabPillItem[]>(
    () => [
      {
        key: GITHUB_FILTER_PRESET.OPEN,
        label: t("chat.panels.manageIssues.stateOpen"),
      },
      {
        key: GITHUB_FILTER_PRESET.ASSIGNED_TO_ME,
        label: t("chat.panels.manageIssues.assignedToMe"),
      },
    ],
    [t]
  );

  const filterMenuOptions = useMemo<RepoFilterOption[]>(
    () => [
      {
        key: GITHUB_FILTER_PRESET.BY_ME,
        label: t("chat.panels.manageIssues.createdByMe"),
      },
      {
        key: GITHUB_FILTER_PRESET.CLOSED,
        label: t("chat.panels.manageIssues.stateClosed"),
      },
      {
        key: GITHUB_QUERY_STATE.ALL,
        label: t("chat.panels.manageIssues.stateAll"),
      },
    ],
    [t]
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoading(true);
      setLoadError(null);

      const resolvedSources = (
        await Promise.all(gitRepos.map((repo) => resolveGitHubRepoSource(repo)))
      ).filter((source): source is GitHubRepoSource => Boolean(source));

      if (cancelled) return;

      setRepoSources(resolvedSources);
      setRepoIssueMap(
        Object.fromEntries(
          resolvedSources.map((source) => [
            getRepoIssueMapKey(source),
            getCachedRepoIssues(source),
          ])
        )
      );
      setRepoPrMap(
        Object.fromEntries(
          resolvedSources.map((source) => [
            getRepoIssueMapKey(source),
            EMPTY_REPO_PRS,
          ])
        )
      );

      if (resolvedSources.length === 0) {
        setLoading(false);
        return;
      }

      const [issueResults, prResults] = await Promise.all([
        Promise.all(resolvedSources.map(loadRepoIssues)),
        Promise.all(resolvedSources.map(loadRepoPrs)),
      ]);
      if (cancelled) return;

      setRepoIssueMap(
        Object.fromEntries(
          issueResults.map((result) => [
            getRepoIssueMapKey(result.source),
            {
              openIssues: result.openIssues,
              closedIssues: result.closedIssues,
              openHasMore: result.openHasMore,
              closedHasMore: result.closedHasMore,
              openNextPage: result.openNextPage,
              closedNextPage: result.closedNextPage,
            },
          ])
        )
      );
      setRepoPrMap(
        Object.fromEntries(
          prResults.map((result) => [
            getRepoIssueMapKey(result.source),
            {
              prs: result.prs,
              error: result.error,
            },
          ])
        )
      );
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
  }, [gitRepos, refreshNonce]);

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
    },
    [searchQuery]
  );

  const handleTypeTabChange = useCallback(
    (key: string) => {
      updateSearchQuery((query) => {
        query.scope =
          key === GITHUB_QUERY_SCOPE.PR
            ? GITHUB_QUERY_SCOPE.PR
            : GITHUB_QUERY_SCOPE.ISSUE;
      });
    },
    [updateSearchQuery]
  );

  const handleFilterMenuSelect = useCallback(
    (key: string) => {
      updateSearchQuery((query) => {
        if (key === GITHUB_FILTER_PRESET.BY_ME) {
          query.author = "@me";
          return;
        }
        if (key === GITHUB_FILTER_PRESET.CLOSED) {
          query.state = GITHUB_QUERY_STATE.CLOSED;
          return;
        }
        if (key === GITHUB_QUERY_STATE.ALL) {
          query.state = GITHUB_QUERY_STATE.ALL;
        }
      });
    },
    [updateSearchQuery]
  );

  const activeTypeTab =
    parsedSearchQuery.scope === GITHUB_QUERY_SCOPE.PR
      ? GITHUB_QUERY_SCOPE.PR
      : GITHUB_QUERY_SCOPE.ISSUE;
  const activeQuickFilterTabs: string[] = [];
  if (parsedSearchQuery.state === GITHUB_QUERY_STATE.OPEN) {
    activeQuickFilterTabs.push(GITHUB_FILTER_PRESET.OPEN);
  }
  if (parsedSearchQuery.assignee === "@me") {
    activeQuickFilterTabs.push(GITHUB_FILTER_PRESET.ASSIGNED_TO_ME);
  }

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
        return sourcePrs.prs.map((pr) => mapPrToManagedPr(pr, source));
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

  const listScrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual exposes imperative helpers that cannot be memoized safely.
  const itemVirtualizer = useVirtualizer({
    count: filteredItems.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => 82,
    overscan: 8,
  });
  const virtualItems = itemVirtualizer.getVirtualItems();

  const handleBackToIssueList = useCallback(() => {
    setChatIssueDetail(null);
  }, []);

  const activeChatIssue = chatIssueDetail?.issue ?? null;
  const activeChatIssueTitle = activeChatIssue
    ? getIssueDetailTitle(activeChatIssue)
    : t("chat.manageIssues.title");
  const activeChatIssueIcon = activeChatIssue ? (
    <IssueStateIcon
      isOpen={activeChatIssue.state === GITHUB_QUERY_STATE.OPEN}
    />
  ) : (
    <ListFilter size={14} strokeWidth={1.8} />
  );

  const headerContent = useMemo(
    () => (
      <span className="flex min-w-0 max-w-full items-center gap-2">
        {activeChatIssue ? (
          <IssueDetailHeaderContent issue={activeChatIssue} />
        ) : (
          <>
            <ChatPanelHeaderTitlePill>
              {t("chat.manageIssues.title")}
            </ChatPanelHeaderTitlePill>
            <span className="h-4 w-px shrink-0 bg-border-2" aria-hidden />
            <RepoFilterPill
              options={repoOptions}
              selectedRepo={effectiveSelectedRepo}
              allReposLabel={t("chat.manageIssues.allRepositories")}
              onSelectRepo={setSelectedRepo}
            />
          </>
        )}
      </span>
    ),
    [activeChatIssue, effectiveSelectedRepo, repoOptions, setSelectedRepo, t]
  );

  usePublishChatPanelHeader({
    content: {
      content: headerContent,
      tabTitle: activeChatIssueTitle,
      tabIcon: activeChatIssueIcon,
      backAction: activeChatIssue ? handleBackToIssueList : null,
      backLabel: t("common:actions.back"),
    },
  });

  const handleRefresh = useCallback(() => {
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

  const handleOpenIssue = useCallback((issue: ManagedIssueItem) => {
    setChatIssueDetail({
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
      setChatIssueDetail((current) => {
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

  const handleCloseChatIssue = useCallback(async () => {
    const currentIssue = chatIssueDetail;
    if (!currentIssue) return;
    const result = await closeIssue({
      remoteUrl: currentIssue.source.remoteUrl,
      issueNumber: currentIssue.issue.number,
    });
    setChatIssueDetail((current) => {
      if (!current || current.issue.html_url !== currentIssue.issue.html_url) {
        return current;
      }
      if (result.data) {
        return { ...current, issue: result.data, error: null };
      }
      return { ...current, error: result.error };
    });
  }, [chatIssueDetail]);

  const handleReopenChatIssue = useCallback(async () => {
    const currentIssue = chatIssueDetail;
    if (!currentIssue) return;
    const result = await reopenIssue({
      remoteUrl: currentIssue.source.remoteUrl,
      issueNumber: currentIssue.issue.number,
    });
    setChatIssueDetail((current) => {
      if (!current || current.issue.html_url !== currentIssue.issue.html_url) {
        return current;
      }
      if (result.data) {
        return { ...current, issue: result.data, error: null };
      }
      return { ...current, error: result.error };
    });
  }, [chatIssueDetail]);

  const handleAddChatIssueComment = useCallback(
    async (body: string) => {
      const currentIssue = chatIssueDetail;
      if (!currentIssue) return;
      setChatIssueDetail((current) =>
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
        setChatIssueDetail((current) =>
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
      setChatIssueDetail((current) =>
        current?.issue.html_url === currentIssue.issue.html_url
          ? { ...current, submittingComment: false, error: result.error }
          : current
      );
      throw new Error(result.error);
    },
    [chatIssueDetail]
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
    if (loading && filteredItems.length === 0) {
      return <Placeholder variant="loading" fillParentHeight />;
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

    if (!loading && filteredItems.length === 0) {
      return <Placeholder variant="no-results" fillParentHeight />;
    }

    return (
      <>
        <div
          className="relative w-full"
          style={{ height: itemVirtualizer.getTotalSize() }}
        >
          {virtualItems.map((virtualItem) => {
            const item = filteredItems[virtualItem.index];
            return (
              <div
                key={`${item.kind}-${item.repo}-${item.id}`}
                ref={itemVirtualizer.measureElement}
                data-index={virtualItem.index}
                className="absolute left-0 top-0 w-full pb-0.5"
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
                    onAddPr={handleAddPr}
                  />
                )}
              </div>
            );
          })}
        </div>
        {hasMoreFilteredIssues ? (
          <div className="flex justify-center py-3">
            <Button
              htmlType="button"
              variant="tertiary"
              appearance="ghost"
              size="small"
              loading={loadingMore}
              disabled={loadingMore}
              onClick={handleLoadMore}
            >
              {loadingMore
                ? t("common:actions.loading")
                : t("common:actions.loadMore")}
            </Button>
          </div>
        ) : null}
        <div className="h-12 shrink-0" aria-hidden />
      </>
    );
  })();

  const issueDetailContent = chatIssueDetail ? (
    <IssueDetailPanel
      issue={chatIssueDetail.issue}
      comments={chatIssueDetail.comments}
      commentsLoading={chatIssueDetail.commentsLoading}
      submittingComment={chatIssueDetail.submittingComment}
      showHeader={false}
      showBackTitleHeader
      backLabel={t("common:actions.back")}
      contentPadding="none"
      onClose={handleBackToIssueList}
      onCloseIssue={handleCloseChatIssue}
      onReopenIssue={handleReopenChatIssue}
      onAddComment={handleAddChatIssueComment}
    />
  ) : null;

  const listDescriptionContent = (
    <section
      className={`${DETAIL_PANEL_TOKENS.contentWidth} flex min-h-0 flex-1 flex-col`}
      data-testid="chat-panel-manage-issues-section"
    >
      <div className="mb-3 flex shrink-0 flex-col gap-1.5 rounded-xl border border-border-1 bg-bg-1 p-2">
        <div className="flex items-center gap-2">
          <TabPill
            tabs={typeSwitchOptions}
            activeTab={activeTypeTab}
            onChange={handleTypeTabChange}
            variant="pill"
            fillWidth={false}
            size="mini"
            buttonStyle
          />
          <RepoFilterPill
            options={repoOptions}
            selectedRepo={effectiveSelectedRepo}
            allReposLabel={t("chat.manageIssues.allRepositories")}
            onSelectRepo={setSelectedRepo}
          />
          <Button
            htmlType="button"
            variant="secondary"
            appearance="outline"
            size="small"
            icon={<ExternalLink size={13} />}
            iconOnly
            className="h-7 w-7"
            aria-label={t("chat.panels.manageIssues.openInGitHub")}
            disabled={!selectedRepoSourceForCreate}
            href={
              selectedRepoSourceForCreate
                ? `https://github.com/${selectedRepoSourceForCreate.repoFullName}`
                : undefined
            }
            target="_blank"
            rel="noreferrer"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <TabPill
            tabs={quickFilterOptions}
            activeTabs={activeQuickFilterTabs}
            onMultiChange={(keys) => {
              const activeKeys = new Set(keys);
              updateSearchQuery((query) => {
                query.state = activeKeys.has(GITHUB_FILTER_PRESET.OPEN)
                  ? GITHUB_QUERY_STATE.OPEN
                  : null;
                query.assignee = activeKeys.has(
                  GITHUB_FILTER_PRESET.ASSIGNED_TO_ME
                )
                  ? "@me"
                  : null;
              });
            }}
            variant="pill"
            fillWidth={false}
            size="mini"
            buttonStyle
          />
          <SearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={t("chat.panels.manageIssues.searchPlaceholder")}
            variant="panel"
            surface="pane"
            hideChevron
            showClearButton
            inputBoxClassName="flex-1"
            className="min-w-0 flex-1"
          />
          <FilterMenuButton
            label={t("chat.panels.manageIssues.filters")}
            options={filterMenuOptions}
            onSelect={handleFilterMenuSelect}
          />
          <Button
            htmlType="button"
            variant="secondary"
            appearance="outline"
            size="small"
            icon={<Plus size={13} />}
            iconOnly
            className="h-7 w-7"
            aria-label={t("chat.panels.manageIssues.createIssueTrigger")}
            onClick={() => setCreateFormOpen(true)}
            disabled={repoSources.length === 0}
          />
          <Button
            htmlType="button"
            variant="secondary"
            appearance="outline"
            size="small"
            icon={<RefreshCw size={13} />}
            iconOnly
            loading={loading}
            loadingSpinIcon
            className="h-7 w-7"
            aria-label={t("common:actions.refresh")}
            onClick={handleRefresh}
          />
        </div>
      </div>
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
      <div
        ref={listScrollRef}
        className="min-h-0 flex-1 overflow-y-auto scrollbar-hide"
      >
        {listContent}
      </div>
    </section>
  );

  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="chat-panel-manage-issues"
    >
      <DetailPanelContainer testId="manage-issues-panel">
        <WorkItemContentStack
          descriptionContent={issueDetailContent ?? listDescriptionContent}
          descriptionClassName="min-h-0 flex flex-1 flex-col px-4 pt-2"
          descriptionFlexible
        />
      </DetailPanelContainer>
    </div>
  );
};

export default ManageIssuesPanelView;

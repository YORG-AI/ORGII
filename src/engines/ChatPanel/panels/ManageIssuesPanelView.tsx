import { useVirtualizer } from "@tanstack/react-virtual";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { BookOpen, CheckCircle2, ChevronDown, CircleDot } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { getGitRemotes } from "@src/api/http/git/remotes";
import type { GitHubIssue } from "@src/api/tauri/github";
import Dropdown from "@src/components/Dropdown";
import DropdownSelectedCheck from "@src/components/Dropdown/DropdownSelectedCheck";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
import TabPill from "@src/components/TabPill";
import type { TabPillItem } from "@src/components/TabPill";
import {
  ChatPanelHeaderTitlePill,
  usePublishChatPanelHeader,
} from "@src/engines/ChatPanel/header";
import { useWorkStationTabs } from "@src/hooks/workStation/tabs";
import WorkItemContentStack from "@src/modules/ProjectManager/WorkItems/components/WorkItemContentStack";
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
import { parseGithubRepoFullName } from "@src/services/git/operations/createPullRequest";
import {
  fetchIssueComments,
  fetchIssues,
} from "@src/services/git/operations/githubIssues";
import { REPO_KIND, reposAtom } from "@src/store/repo";
import type { Repo } from "@src/store/repo/types";
import { workstationSelectedIssueAtom } from "@src/store/workstation/codeEditor/workstationIssueAtom";
import { createGitHubIssueDetailTab } from "@src/store/workstation/tabs";

const ISSUE_TAB = {
  ALL: "all",
  ACTIVE: "active",
  REVIEW_REQUESTS: "reviewRequests",
  DONE: "done",
} as const;

const ISSUE_REPO_FILTER = {
  ALL: "all",
} as const;

const ISSUE_PAGE_SIZE = 50;

type IssueTab = (typeof ISSUE_TAB)[keyof typeof ISSUE_TAB];
type IssueRepoFilter = string;

const manageIssuesActiveTabAtom = atomWithStorage<IssueTab>(
  "orgii:chatPanelManageIssues:activeTab",
  ISSUE_TAB.ALL
);

const manageIssuesSelectedRepoAtom = atomWithStorage<IssueRepoFilter>(
  "orgii:chatPanelManageIssues:selectedRepo",
  ISSUE_REPO_FILTER.ALL
);

type IssueState = GitHubIssue["state"];
type IssuePageState = Extract<IssueState, "open" | "closed">;

type ManagedIssueLabel = GitHubIssue["labels"][number];

interface ManagedIssueItem {
  id: number;
  title: string;
  repo: string;
  repoPath: string;
  remoteUrl: string;
  rawIssue: GitHubIssue;
  author: string;
  timeAgo: string;
  state: IssueState;
  labels: ManagedIssueLabel[];
  comments: number;
  updatedAt: string;
}

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
}

interface RepoIssueState {
  openIssues: GitHubIssue[];
  closedIssues: GitHubIssue[];
  openHasMore: boolean;
  closedHasMore: boolean;
  openNextPage: number | null;
  closedNextPage: number | null;
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

const EMPTY_REPO_ISSUES: RepoIssueState = {
  openIssues: [],
  closedIssues: [],
  openHasMore: false,
  closedHasMore: false,
  openNextPage: null,
  closedNextPage: null,
};

function IssueStateIcon({ state }: { state: IssueState }): React.ReactNode {
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
    id: issue.number,
    title: issue.title,
    repo: source.repoFullName,
    repoPath: source.repoPath,
    remoteUrl: source.remoteUrl,
    rawIssue: issue,
    author: issue.user.login,
    timeAgo: formatIssueTimeAgo(issue.updated_at),
    state: issue.state,
    labels: issue.labels,
    comments: issue.comments,
    updatedAt: issue.updated_at,
  };
}

function issueMatchesTab(
  issue: ManagedIssueItem,
  activeTab: IssueTab
): boolean {
  switch (activeTab) {
    case ISSUE_TAB.ACTIVE:
      return issue.state === "open";
    case ISSUE_TAB.REVIEW_REQUESTS:
      return issue.comments > 0;
    case ISSUE_TAB.DONE:
      return issue.state === "closed";
    case ISSUE_TAB.ALL:
      return true;
  }
}

function issueMatchesRepo(
  issue: ManagedIssueItem,
  repoFilter: IssueRepoFilter
): boolean {
  return repoFilter === ISSUE_REPO_FILTER.ALL || issue.repo === repoFilter;
}

function getIssuePageStatesForTab(activeTab: IssueTab): IssuePageState[] {
  switch (activeTab) {
    case ISSUE_TAB.ACTIVE:
      return ["open"];
    case ISSUE_TAB.DONE:
      return ["closed"];
    case ISSUE_TAB.ALL:
    case ISSUE_TAB.REVIEW_REQUESTS:
      return ["open", "closed"];
  }
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

  return {
    repoId: repo.id,
    repoPath: repo.path,
    label: repo.name,
    remoteUrl,
    repoFullName,
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
  const [menuVisible, setMenuVisible] = useState(false);
  const closeMenu = useCallback(() => setMenuVisible(false), []);
  const selectedOption =
    options.find((option) => option.key === selectedRepo) ?? options[0];
  const selectedLabel = selectedOption?.label ?? allReposLabel;

  const droplist = (
    <div className={`${DROPDOWN_CLASSES.menuPanelBase} min-w-[190px]`}>
      {options.map((option) => {
        const isSelected = option.key === selectedRepo;
        return (
          <button
            key={option.key}
            type="button"
            className={DROPDOWN_CLASSES.menuActionItem}
            onClick={() => {
              onSelectRepo(option.key);
              closeMenu();
            }}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <BookOpen size={DROPDOWN_ITEM.iconSize} className="text-text-3" />
              <span className="truncate">{option.label}</span>
            </span>
            {isSelected ? <DropdownSelectedCheck /> : null}
          </button>
        );
      })}
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
      <button
        type="button"
        className="flex h-7 min-w-0 max-w-full cursor-default items-center gap-1.5 rounded-lg px-1.5 text-[13px] font-medium text-text-1 transition-colors hover:bg-surface-hover"
        aria-label={selectedLabel}
        aria-expanded={menuVisible}
      >
        <span className="max-w-40 truncate">{selectedLabel}</span>
        <ChevronDown size={12} className="shrink-0 text-text-3" />
      </button>
    </Dropdown>
  );
}

function ManagedIssueRow({
  issue,
  onOpenIssue,
}: {
  issue: ManagedIssueItem;
  onOpenIssue: (issue: ManagedIssueItem) => void;
}): React.ReactNode {
  const stateClassName =
    issue.state === "closed" ? "text-purple-6" : "text-success-6";

  return (
    <button
      type="button"
      className="focus-visible:ring-accent-5/50 group w-full rounded-xl px-3 py-3 text-left transition-colors hover:bg-fill-1/60 focus-visible:outline-none focus-visible:ring-2"
      onClick={() => onOpenIssue(issue)}
      aria-label={`Open issue #${issue.id}: ${issue.title}`}
    >
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 shrink-0 ${stateClassName}`}>
          <IssueStateIcon state={issue.state} />
        </span>
        <div className="min-w-0 flex-1">
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
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-text-3">
            <span>{issue.repo}</span>
            <span>·</span>
            <span>{issue.author}</span>
            <span>·</span>
            <span>{issue.timeAgo}</span>
          </div>
        </div>
      </div>
    </button>
  );
}

const ManageIssuesPanelView: React.FC = () => {
  const { t } = useTranslation(["sessions", "common"]);
  const repos = useAtomValue(reposAtom);
  const [activeTab, setActiveTab] = useAtom(manageIssuesActiveTabAtom);
  const [selectedRepo, setSelectedRepo] = useAtom(manageIssuesSelectedRepoAtom);
  const setSelectedIssue = useSetAtom(workstationSelectedIssueAtom);
  const { openTab } = useWorkStationTabs();
  const [repoSources, setRepoSources] = useState<GitHubRepoSource[]>([]);
  const [repoIssueMap, setRepoIssueMap] = useState<
    Record<string, RepoIssueState>
  >({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const gitRepos = useMemo(
    () => repos.filter((repo) => repo.kind === REPO_KIND.GIT && repo.path),
    [repos]
  );

  const tabs = useMemo<TabPillItem[]>(
    () => [
      { key: ISSUE_TAB.ALL, label: t("chat.manageIssues.tabs.all") },
      { key: ISSUE_TAB.ACTIVE, label: t("chat.manageIssues.tabs.active") },
      {
        key: ISSUE_TAB.REVIEW_REQUESTS,
        label: t("chat.manageIssues.tabs.reviewRequests"),
      },
      { key: ISSUE_TAB.DONE, label: t("chat.manageIssues.tabs.done") },
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

      if (resolvedSources.length === 0) {
        setLoading(false);
        return;
      }

      const results = await Promise.all(resolvedSources.map(loadRepoIssues));
      if (cancelled) return;

      setRepoIssueMap(
        Object.fromEntries(
          results.map((result) => [
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
      setLoadError(results.find((result) => result.error)?.error ?? null);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [gitRepos, refreshNonce]);

  const effectiveSelectedRepo =
    selectedRepo === ISSUE_REPO_FILTER.ALL ||
    repoSources.some((source) => source.repoFullName === selectedRepo)
      ? selectedRepo
      : ISSUE_REPO_FILTER.ALL;

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
      repoSources
        .flatMap((source) => {
          const sourceIssues =
            repoIssueMap[getRepoIssueMapKey(source)] ?? EMPTY_REPO_ISSUES;
          return [...sourceIssues.openIssues, ...sourceIssues.closedIssues].map(
            (issue) => mapIssueToManagedIssue(issue, source)
          );
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [repoIssueMap, repoSources]
  );

  const filteredIssues = useMemo(
    () =>
      issues.filter(
        (issue) =>
          issueMatchesTab(issue, activeTab) &&
          issueMatchesRepo(issue, effectiveSelectedRepo)
      ),
    [activeTab, effectiveSelectedRepo, issues]
  );

  const pageStates = useMemo(
    () => getIssuePageStatesForTab(activeTab),
    [activeTab]
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
  const issueVirtualizer = useVirtualizer({
    count: filteredIssues.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => 88,
    overscan: 8,
  });
  const virtualIssues = issueVirtualizer.getVirtualItems();

  const headerContent = useMemo(
    () => (
      <span className="flex min-w-0 max-w-full items-center gap-2">
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
      </span>
    ),
    [effectiveSelectedRepo, repoOptions, setSelectedRepo, t]
  );

  usePublishChatPanelHeader({
    content: { content: headerContent },
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

  const handleOpenIssue = useCallback(
    (issue: ManagedIssueItem) => {
      setSelectedIssue({
        issue: issue.rawIssue,
        comments: [],
        loading: false,
        commentsLoading: true,
        error: null,
        submittingComment: false,
      });
      openTab(
        createGitHubIssueDetailTab(issue.id, issue.title, issue.repoPath)
      );

      void (async () => {
        const result = await fetchIssueComments({
          remoteUrl: issue.remoteUrl,
          issueNumber: issue.id,
        });
        setSelectedIssue((current) => {
          if (current.issue?.html_url !== issue.rawIssue.html_url)
            return current;
          return {
            ...current,
            comments: result.data ?? [],
            commentsLoading: false,
            error: result.error ?? null,
          };
        });
      })();
    },
    [openTab, setSelectedIssue]
  );

  const listContent = (() => {
    if (loading && issues.length === 0) {
      return <Placeholder variant="loading" fillParentHeight />;
    }

    if (loadError && issues.length === 0) {
      return (
        <Placeholder
          variant="error"
          subtitle={loadError}
          action={{ label: t("common:actions.retry"), onClick: handleRefresh }}
          fillParentHeight
        />
      );
    }

    if (repoSources.length === 0) {
      return <Placeholder variant="empty" fillParentHeight />;
    }

    if (filteredIssues.length === 0) {
      return <Placeholder variant="no-results" fillParentHeight />;
    }

    return (
      <>
        <div
          className="relative w-full"
          style={{ height: issueVirtualizer.getTotalSize() }}
        >
          {virtualIssues.map((virtualIssue) => {
            const issue = filteredIssues[virtualIssue.index];
            return (
              <div
                key={`${issue.repo}-${issue.id}`}
                ref={issueVirtualizer.measureElement}
                data-index={virtualIssue.index}
                className="absolute left-0 top-0 w-full pb-0.5"
                style={{ transform: `translateY(${virtualIssue.start}px)` }}
              >
                <ManagedIssueRow issue={issue} onOpenIssue={handleOpenIssue} />
              </div>
            );
          })}
        </div>
        {hasMoreFilteredIssues ? (
          <div className="flex justify-center py-3">
            <button
              type="button"
              className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-text-2 transition-colors hover:bg-fill-1 disabled:cursor-default disabled:opacity-60"
              onClick={handleLoadMore}
              disabled={loadingMore}
            >
              {loadingMore
                ? t("common:actions.loading")
                : t("common:actions.loadMore")}
            </button>
          </div>
        ) : null}
      </>
    );
  })();

  const descriptionContent = (
    <section
      className={`${DETAIL_PANEL_TOKENS.contentWidth} flex min-h-0 flex-1 flex-col`}
      data-testid="chat-panel-manage-issues-section"
    >
      <div className="mb-4 flex shrink-0 items-center justify-start">
        <TabPill
          tabs={tabs}
          activeTab={activeTab}
          onChange={(key) => setActiveTab(key as IssueTab)}
          variant="simple"
          fillWidth={false}
          size="large"
        />
      </div>
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
          descriptionContent={descriptionContent}
          descriptionClassName="min-h-0 flex flex-1 flex-col px-4 pt-2"
          descriptionFlexible
        />
      </DetailPanelContainer>
    </div>
  );
};

export default ManageIssuesPanelView;

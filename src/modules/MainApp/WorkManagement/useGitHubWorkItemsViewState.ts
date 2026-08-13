import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import {
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { PullRequestListState } from "@src/api/tauri/github";

import {
  GITHUB_QUERY_SCOPE,
  GITHUB_QUERY_STATE,
  getIssuePageStatesForQuery,
  parseGitHubSearchQuery,
  serializeGitHubSearchQuery,
} from "./githubWorkItemsSearchQuery";
import type {
  GitHubQueryScope,
  ParsedGitHubSearchQuery,
} from "./githubWorkItemsSearchQuery";
import {
  getCachedOpsGitHubView,
  getOpsPrListStates,
  setCachedOpsGitHubView,
} from "./githubWorkItemsViewCache";
import type { OpsGitHubViewScope } from "./githubWorkItemsViewCache";

export const ISSUE_REPO_FILTER = {
  ALL: "all",
  CURRENT_WORKSTATION: "currentWorkstation",
} as const;

export const GITHUB_FILTER_PRESET = {
  ASSIGNED_TO_ME: "assignedToMe",
  BY_ME: "byMe",
} as const;

const selectedRepoAtom = atomWithStorage<string>(
  "orgii:kanbanGitHub:selectedRepo:v1",
  ISSUE_REPO_FILTER.CURRENT_WORKSTATION
);

interface ViewState {
  searchQuery: string;
  currentPage: number;
}

type ViewStateByScope = Record<OpsGitHubViewScope, ViewState>;

const GLUED_GITHUB_QUALIFIER_PATTERN =
  /\b(is:(?:issue|pr|pull-request|open|closed|merged))(?=\S)/gi;

function restoreGitHubQualifierBoundaries(rawQuery: string): string {
  return rawQuery.replace(GLUED_GITHUB_QUALIFIER_PATTERN, "$1 ");
}

export function normalizeGitHubSearchQueryForScope(
  scope: OpsGitHubViewScope,
  rawQuery: string
): string {
  const repairedQuery = restoreGitHubQualifierBoundaries(rawQuery);
  const query = parseGitHubSearchQuery(repairedQuery);
  query.scope = scope;
  if (scope === GITHUB_QUERY_SCOPE.PR && query.state === null) {
    query.state = GITHUB_QUERY_STATE.OPEN;
  }
  const normalizedQuery = serializeGitHubSearchQuery(query);
  const needsEditableSeparator =
    query.freeText.length === 0 || /\s$/.test(repairedQuery);
  return needsEditableSeparator ? `${normalizedQuery} ` : normalizedQuery;
}

function getInitialViewState(scope: OpsGitHubViewScope): ViewState {
  const cached = getCachedOpsGitHubView(scope);
  return {
    searchQuery: normalizeGitHubSearchQueryForScope(
      scope,
      cached?.searchQuery ?? `is:${scope} is:open`
    ),
    currentPage:
      scope === GITHUB_QUERY_SCOPE.PR ? 1 : (cached?.currentPage ?? 1),
  };
}

export function applyGitHubPersonalFilters(
  query: ParsedGitHubSearchQuery,
  values: (string | number)[]
): void {
  query.author = values.includes(GITHUB_FILTER_PRESET.BY_ME) ? "@me" : null;
  query.assignee = values.includes(GITHUB_FILTER_PRESET.ASSIGNED_TO_ME)
    ? "@me"
    : null;
}

export function getSelectedGitHubPersonalFilters(
  query: ParsedGitHubSearchQuery
): string[] {
  return [
    ...(query.author === "@me" ? [GITHUB_FILTER_PRESET.BY_ME] : []),
    ...(query.assignee === "@me" ? [GITHUB_FILTER_PRESET.ASSIGNED_TO_ME] : []),
  ];
}

export function areRequestedPrStatesLoaded(
  states: PullRequestListState[],
  openLoaded: boolean,
  closedLoaded: boolean
): boolean {
  return states.every((state) =>
    state === GITHUB_QUERY_STATE.OPEN ? openLoaded : closedLoaded
  );
}

export function useGitHubWorkItemsViewState({
  scope,
}: {
  scope: Extract<GitHubQueryScope, "issue" | "pr">;
}) {
  const [selectedRepo, setSelectedRepo] = useAtom(selectedRepoAtom);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [viewByScope, setViewByScope] = useState<ViewStateByScope>(() => ({
    issue: getInitialViewState("issue"),
    pr: getInitialViewState("pr"),
  }));
  const { searchQuery, currentPage } = viewByScope[scope];
  const parsedSearchQuery = useMemo(() => {
    const query = parseGitHubSearchQuery(searchQuery);
    query.scope = scope;
    if (scope === GITHUB_QUERY_SCOPE.PR && query.state === null) {
      query.state = GITHUB_QUERY_STATE.OPEN;
    }
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
  const selectedPersonalFilters = useMemo(
    () => getSelectedGitHubPersonalFilters(parsedSearchQuery),
    [parsedSearchQuery]
  );

  useEffect(() => {
    setCachedOpsGitHubView(scope, { searchQuery, currentPage });
  }, [currentPage, scope, searchQuery]);

  const setCurrentPage = useCallback(
    (update: SetStateAction<number>) => {
      setViewByScope((current) => {
        const previousPage = current[scope].currentPage;
        const nextPage =
          typeof update === "function" ? update(previousPage) : update;
        return {
          ...current,
          [scope]: { ...current[scope], currentPage: nextPage },
        };
      });
    },
    [scope]
  );
  const setScopedSearchQuery = useCallback(
    (query: string) => {
      setViewByScope((current) => ({
        ...current,
        [scope]: {
          searchQuery: normalizeGitHubSearchQueryForScope(scope, query),
          currentPage: 1,
        },
      }));
    },
    [scope]
  );
  const updateSearchQuery = useCallback(
    (mutate: (query: ParsedGitHubSearchQuery) => void) => {
      const nextQuery = parseGitHubSearchQuery(searchQuery);
      mutate(nextQuery);
      setScopedSearchQuery(
        normalizeGitHubSearchQueryForScope(
          scope,
          serializeGitHubSearchQuery(nextQuery)
        )
      );
    },
    [scope, searchQuery, setScopedSearchQuery]
  );
  const selectRepo = useCallback(
    (repo: string) => {
      setSelectedRepo(repo);
      setCurrentPage(1);
    },
    [setCurrentPage, setSelectedRepo]
  );
  const selectPersonalFilters = useCallback(
    (values: (string | number)[]) => {
      updateSearchQuery((query) => applyGitHubPersonalFilters(query, values));
    },
    [updateSearchQuery]
  );
  const refresh = useCallback(() => {
    setCurrentPage(1);
    setRefreshNonce((current) => current + 1);
  }, [setCurrentPage]);

  return {
    selectedRepo,
    refreshNonce,
    currentPage,
    setCurrentPage,
    searchQuery,
    parsedSearchQuery,
    selectedIssueListStates,
    selectedPrListStates,
    selectedPersonalFilters,
    updateSearchQuery,
    changeSearchQuery: setScopedSearchQuery,
    selectRepo,
    selectPersonalFilters,
    refresh,
  };
}

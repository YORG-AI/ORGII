import { useAtomValue } from "jotai";
import { useCallback, useMemo, useState } from "react";

import type { PullRequestListState } from "@src/api/tauri/github";
import { sidebarActiveCloudOrgIdAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { org2CloudRepoScopesAtom } from "@src/features/Org2Cloud/org2CloudSyncAtoms";
import {
  type OrgScopeFilterRepo,
  repoMatchesOrgScopes,
} from "@src/features/TeamCollaboration/orgScopeRepoFilter";
import { useShareableScopeKeyVersion } from "@src/features/TeamCollaboration/repoScopeResolver";
import {
  type ManagedPrItem,
  mapPrToManagedItem,
} from "@src/modules/MainApp/WorkManagement/githubManagedItemModel";
import { GITHUB_QUERY_SCOPE } from "@src/modules/MainApp/WorkManagement/githubWorkItemsSearchQuery";
import type { GitHubIssuePageState } from "@src/modules/MainApp/WorkManagement/githubWorkItemsSearchQuery";
import {
  EMPTY_REPO_PRS,
  getRepoIssueMapKey,
  useGitHubWorkItemsLoadLifecycle,
} from "@src/modules/MainApp/WorkManagement/useGitHubWorkItemsLoadLifecycle";
import { type Repo, reposAtom } from "@src/store/repo";

const OPEN_PR_STATES: PullRequestListState[] = ["open"];
const NO_ISSUE_STATES: GitHubIssuePageState[] = [];

export interface TeamInboxPullRequestsState {
  items: ManagedPrItem[];
  loading: boolean;
  initialLoading: boolean;
  error: string | null;
  refresh: () => void;
}

type TeamInboxRepoScopeMatcher = (
  repo: OrgScopeFilterRepo,
  orgScopes: string[]
) => boolean;

export function selectTeamInboxPullRequestRepos(
  repos: Repo[],
  activeCloudOrgId: string | null,
  scopesByOrg: Readonly<Record<string, string[]>>,
  matchesOrgScopes: TeamInboxRepoScopeMatcher = repoMatchesOrgScopes
): Repo[] {
  if (!activeCloudOrgId) return repos;
  const orgScopes = scopesByOrg[activeCloudOrgId] ?? [];
  if (orgScopes.length === 0) return [];
  return repos.filter((repo) =>
    matchesOrgScopes(
      {
        repo_url: repo.repo_url,
        fs_uri: repo.fs_uri ?? repo.path,
      },
      orgScopes
    )
  );
}

export function useTeamInboxPullRequests(): TeamInboxPullRequestsState {
  const repos = useAtomValue(reposAtom);
  const activeCloudOrgId = useAtomValue(sidebarActiveCloudOrgIdAtom);
  const scopesByOrg = useAtomValue(org2CloudRepoScopesAtom);
  const scopeKeyVersion = useShareableScopeKeyVersion();
  const [refreshNonce, setRefreshNonce] = useState(0);
  const scopedRepos = useMemo(() => {
    void scopeKeyVersion;
    return selectTeamInboxPullRequestRepos(
      repos,
      activeCloudOrgId,
      scopesByOrg
    );
  }, [activeCloudOrgId, repos, scopeKeyVersion, scopesByOrg]);
  const scopedRepoIds = useMemo(
    () => new Set(scopedRepos.map((repo) => repo.id)),
    [scopedRepos]
  );
  const { repoSources, repoPrMap, loading, initialLoading, loadError } =
    useGitHubWorkItemsLoadLifecycle({
      repos: scopedRepos,
      scope: GITHUB_QUERY_SCOPE.PR,
      issueStates: NO_ISSUE_STATES,
      prStates: OPEN_PR_STATES,
      refreshNonce,
    });
  const items = useMemo(
    () =>
      repoSources
        .filter((source) => scopedRepoIds.has(source.repoId))
        .flatMap((source) => {
          const state = repoPrMap[getRepoIssueMapKey(source)] ?? EMPTY_REPO_PRS;
          return state.openPrs.map((pr) => mapPrToManagedItem(pr, source));
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [repoPrMap, repoSources, scopedRepoIds]
  );
  const refresh = useCallback(() => {
    setRefreshNonce((current) => current + 1);
  }, []);

  return {
    items,
    loading,
    initialLoading,
    error: loadError,
    refresh,
  };
}

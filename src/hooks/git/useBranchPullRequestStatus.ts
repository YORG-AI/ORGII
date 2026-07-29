import { useEffect, useMemo, useRef, useState } from "react";

import { getGitDefaultBranch } from "@src/api/http/git/branches";
import { getGitRemotes } from "@src/api/http/git/remotes";
import {
  type GitHubChecksSummary,
  findPullRequestLocal,
  getChecksLocal,
  getGitCredentialForRemote,
  getPRLocal,
} from "@src/api/tauri/github";
import {
  type BranchCiStatus,
  type BranchPullRequestStatusSnapshot,
  buildBranchPullRequestStatusKey,
  buildGitHubCompareUrl,
  evictOtherBranchPullRequestStatusIdentities,
  getCachedBranchPullRequestStatus,
  isBranchPullRequestStatusFresh,
  loadBranchPullRequestStatusCoalesced,
  resolveBranchCiStatus,
  setCachedBranchPullRequestStatus,
} from "@src/services/git/branchPullRequestStatus";
import { parseGithubRepoFullName } from "@src/services/git/operations/createPullRequest";

const GITHUB_ENDPOINT = "https://github.com";

interface BranchPullRequestStatusState extends BranchPullRequestStatusSnapshot {
  compareUrl: string | null;
  defaultBranch: string | null;
  loading: boolean;
  refreshing: boolean;
  repoFullName: string | null;
  scopeKey: string | null;
}

const EMPTY_STATE: BranchPullRequestStatusState = {
  compareUrl: null,
  defaultBranch: null,
  pr: null,
  checks: null,
  checksUnavailable: false,
  loading: false,
  refreshing: false,
  repoFullName: null,
  scopeKey: null,
};

export interface UseBranchPullRequestStatusOptions {
  branchName?: string;
  repoId?: string;
  repoPath?: string;
}

export interface UseBranchPullRequestStatusResult extends Omit<
  BranchPullRequestStatusState,
  "scopeKey"
> {
  ciStatus: BranchCiStatus | null;
}

function isGitHubRemote(remoteUrl: string): boolean {
  return /(?:^|@|\/\/)github\.com(?::|\/)/i.test(remoteUrl);
}

function resolveAuthScope(
  credential: {
    connection_id: string;
    source: string;
    username: string;
  } | null
): string {
  return credential
    ? `${credential.connection_id}:${credential.source}:${credential.username}`
    : "anonymous";
}

async function fetchStatusSnapshot(
  repoFullName: string,
  branchName: string
): Promise<BranchPullRequestStatusSnapshot> {
  const foundPr = await findPullRequestLocal(repoFullName, branchName);
  const pr =
    foundPr?.state.toLowerCase() === "open" && foundPr.number > 0
      ? foundPr
      : null;
  if (!pr) {
    return { pr: null, checks: null, checksUnavailable: false };
  }

  let checks: GitHubChecksSummary | null = null;
  let checksUnavailable = false;
  try {
    const detail = await getPRLocal(repoFullName, pr.number);
    const head = detail.head;
    const headSha =
      head && typeof head === "object"
        ? (head as Record<string, unknown>).sha
        : null;
    if (typeof headSha !== "string" || !headSha) {
      throw new Error("Pull request head SHA is unavailable");
    }
    checks = await getChecksLocal(repoFullName, headSha);
  } catch {
    checksUnavailable = true;
  }
  return { pr, checks, checksUnavailable };
}

export function useBranchPullRequestStatus({
  branchName,
  repoId,
  repoPath,
}: UseBranchPullRequestStatusOptions): UseBranchPullRequestStatusResult {
  const [state, setState] = useState<BranchPullRequestStatusState>(EMPTY_STATE);
  const generationRef = useRef(0);
  const scopeKey =
    repoPath && branchName
      ? `${repoId ?? "default"}|${repoPath}|${branchName}`
      : null;

  useEffect(() => {
    let disposed = false;

    if (!repoPath || !branchName) {
      generationRef.current += 1;
      return;
    }

    const load = async () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      const generation = ++generationRef.current;
      const isCurrent = () => !disposed && generation === generationRef.current;

      const [remotes, defaultBranchResult, credentialResult] =
        await Promise.all([
          getGitRemotes({
            repo_id: repoId ?? "default",
            repo_path: repoPath,
          }).catch(() => null),
          getGitDefaultBranch({
            repo_id: repoId ?? "default",
            repo_path: repoPath,
            remote: "origin",
          }).catch(() => null),
          getGitCredentialForRemote(GITHUB_ENDPOINT).catch(() => null),
        ]);
      if (!isCurrent()) return;

      const origin = remotes?.remotes?.find(
        (remote) => remote.name === "origin"
      );
      if (!origin?.url || !isGitHubRemote(origin.url)) {
        setState(EMPTY_STATE);
        return;
      }

      const repoFullName = parseGithubRepoFullName(origin.url);
      if (!repoFullName) {
        setState(EMPTY_STATE);
        return;
      }

      const defaultBranch = defaultBranchResult?.name || "main";
      const compareUrl = buildGitHubCompareUrl(
        repoFullName,
        defaultBranch,
        branchName
      );
      const authScope = resolveAuthScope(credentialResult);
      evictOtherBranchPullRequestStatusIdentities({
        activeAuthScope: authScope,
        repoFullName,
      });
      const cacheKey = buildBranchPullRequestStatusKey({
        authScope,
        branchName,
        repoFullName,
      });
      const cached = getCachedBranchPullRequestStatus(cacheKey);
      const cachedIsFresh = isBranchPullRequestStatusFresh(cached);

      setState({
        compareUrl,
        defaultBranch,
        repoFullName,
        pr: cached?.pr ?? null,
        checks: cached?.checks ?? null,
        checksUnavailable: cached?.checksUnavailable ?? false,
        loading: !cached,
        refreshing: Boolean(cached && !cachedIsFresh),
        scopeKey,
      });
      if (cachedIsFresh) return;

      try {
        const snapshot = await loadBranchPullRequestStatusCoalesced(
          cacheKey,
          () => fetchStatusSnapshot(repoFullName, branchName)
        );
        if (!isCurrent()) return;
        setCachedBranchPullRequestStatus(cacheKey, snapshot);
        setState({
          compareUrl,
          defaultBranch,
          repoFullName,
          ...snapshot,
          loading: false,
          refreshing: false,
          scopeKey,
        });
      } catch {
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          loading: false,
          refreshing: false,
        }));
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void load();
      }
    };

    if (
      typeof document === "undefined" ||
      document.visibilityState !== "hidden"
    ) {
      void load();
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      disposed = true;
      generationRef.current += 1;
      if (typeof document !== "undefined") {
        document.removeEventListener(
          "visibilitychange",
          handleVisibilityChange
        );
      }
    };
  }, [branchName, repoId, repoPath, scopeKey]);

  const visibleState =
    state.scopeKey === scopeKey
      ? state
      : {
          ...EMPTY_STATE,
          scopeKey,
        };

  const ciStatus = useMemo(
    () =>
      resolveBranchCiStatus({
        pr: visibleState.pr,
        checks: visibleState.checks,
        checksUnavailable: visibleState.checksUnavailable,
        loading: visibleState.loading || visibleState.refreshing,
      }),
    [
      visibleState.checks,
      visibleState.checksUnavailable,
      visibleState.loading,
      visibleState.pr,
      visibleState.refreshing,
    ]
  );

  const { scopeKey: _scopeKey, ...result } = visibleState;
  return { ...result, ciStatus };
}

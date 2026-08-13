/**
 * useWorktreeSourceData
 *
 * Data layer for `WorktreeSourceModal`. Preloads GitHub (PR/issue) and branch
 * data in parallel the moment the modal opens (as soon as `repoPath` is known),
 * so switching tabs never re-triggers a spinner. Results are cached per repo
 * key with a TTL and reused on reopen / tab-switch:
 *
 * - **GitHub** → dedicated `worktreeGithubCacheAtom` (45s TTL, LRU-bounded).
 * - **Branches** → reuses the app-wide `branchCacheAtom` (`@src/store/repo`,
 *   5-min TTL, shared with `BranchPalette`) — no second branch cache.
 *
 * Stale-while-revalidate: when a cached entry exists but is past its TTL, the
 * previous list stays visible while a background refresh runs (`refreshing`
 * true); the list is never cleared to a spinner. A cache hit (fresh) skips the
 * fetch and the loading state entirely.
 *
 * Race-safety: concurrent loads for the same repo key are de-duped via a
 * module-scoped in-flight registry, so remounting the modal mid-flight (or the
 * two effects racing) never doubles the network calls.
 */
import { useAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getGitBranches } from "@src/api/http/git";
import { getGitRemotes } from "@src/api/http/git/remotes";
import {
  type GitHubIssue,
  type OpenPRItem,
  getGitCredentialForRemote,
  listIssuesLocal,
  listOpenPRsLocal,
} from "@src/api/tauri/github";
import { parseGithubRepoFullName } from "@src/services/git/operations/createPullRequest";
import {
  type Branch,
  branchCacheAtom,
  getBranchesFromCache,
  isBranchCacheFresh,
  setBranchCacheWithLRU,
} from "@src/store/repo";
import {
  type WorktreeGithubData,
  worktreeGithubCacheAtom,
} from "@src/store/session/worktreeSourceCacheAtom";

import {
  type WorktreeBranchOption,
  branchCacheEntryToOptions,
  sortBranchOptions,
} from "./worktreeBranchSource";
import {
  WORKTREE_GITHUB_CACHE_TTL_MS,
  createInflightRegistry,
  evictOtherWorktreeGithubIdentities,
  getWorktreeCacheFreshness,
  resolveWorktreeGithubCacheKey,
  resolveWorktreeRepoKey,
  writeWorktreeCacheEntry,
} from "./worktreeSourceCache";

const GITHUB_PAGE_SIZE = 30;
const GITHUB_ENDPOINT = "github.com";

/** Public load state consumed by the modal's six-state UI. */
export type WorktreeLoadState =
  | "idle"
  | "loading"
  | "ready"
  | "empty"
  | "error";

// Module-scoped in-flight registries survive modal remounts, so a fetch that
// began before the modal was closed + reopened is joined, not duplicated.
const githubInflight = createInflightRegistry<WorktreeGithubData>();
const branchInflight = createInflightRegistry<Branch[] | undefined>();

async function resolveGithubAuthScope(): Promise<string> {
  const credential = await getGitCredentialForRemote(
    `https://${GITHUB_ENDPOINT}`
  );
  return credential
    ? `${GITHUB_ENDPOINT}:${credential.connection_id}:${credential.source}:${credential.username}`
    : `${GITHUB_ENDPOINT}:anonymous`;
}

async function fetchGithubData(
  repoId: string | undefined,
  repoPath: string
): Promise<WorktreeGithubData> {
  const remotes = await getGitRemotes({
    repo_id: repoId || "default",
    repo_path: repoPath,
  });
  const origin = remotes?.remotes?.find((remote) => remote.name === "origin");
  const repoFullName = origin?.url ? parseGithubRepoFullName(origin.url) : null;

  if (!repoFullName) return { prs: [], issues: [], repoFullName: null };

  const [prsResult, issuesResult] = await Promise.allSettled([
    listOpenPRsLocal(repoFullName, GITHUB_PAGE_SIZE),
    listIssuesLocal(repoFullName, {
      state: "open",
      page: 1,
      perPage: GITHUB_PAGE_SIZE,
    }),
  ]);

  // Both sources failing is a hard error (surface the message). One failing is
  // a partial result — keep whatever came back.
  if (prsResult.status === "rejected" && issuesResult.status === "rejected") {
    throw new Error(String(prsResult.reason || issuesResult.reason));
  }

  const prs: OpenPRItem[] =
    prsResult.status === "fulfilled" ? prsResult.value : [];
  const prNumbers = new Set(prs.map((pr) => pr.number));
  const issues: GitHubIssue[] =
    issuesResult.status === "fulfilled"
      ? issuesResult.value.issues.filter(
          (issue) => !prNumbers.has(issue.number)
        )
      : [];

  return { prs, issues, repoFullName };
}

async function fetchBranchList(
  repoId: string | undefined,
  repoPath: string
): Promise<Branch[] | undefined> {
  const response = await getGitBranches({
    repo_id: repoId || "default",
    repo_path: repoPath,
    include_remote: true,
  });
  // `getGitBranches` swallows failures and resolves to `undefined` — propagate
  // that so the caller can render a retryable error instead of a false "empty".
  if (!response) return undefined;
  return response.branches.map((branch) => ({
    name: branch.name,
    isCurrent: branch.is_current,
    isRemote: branch.branch_type === "remote",
    lastCommitDate: branch.last_commit_date,
  }));
}

export interface UseWorktreeSourceDataOptions {
  open: boolean;
  repoId?: string;
  repoPath?: string;
  /** Skip branch I/O for consumers that only need the shared GitHub slice. */
  loadBranches?: boolean;
}

export interface WorktreeGithubSlice {
  prs: OpenPRItem[];
  issues: GitHubIssue[];
  repoFullName: string | null;
  state: WorktreeLoadState;
  error: string | null;
  /** True while a background refresh runs over an existing (stale) list. */
  refreshing: boolean;
  refresh: () => void;
}

export interface WorktreeBranchSlice {
  options: WorktreeBranchOption[];
  state: WorktreeLoadState;
  error: string | null;
  refreshing: boolean;
  refresh: () => void;
}

export interface UseWorktreeSourceDataResult {
  github: WorktreeGithubSlice;
  branch: WorktreeBranchSlice;
}

export function useWorktreeSourceData({
  open,
  repoId,
  repoPath,
  loadBranches = true,
}: UseWorktreeSourceDataOptions): UseWorktreeSourceDataResult {
  const githubRepoKey = resolveWorktreeRepoKey(repoId, repoPath);
  // Branch cache is keyed by raw repoId (matching `BranchPalette` /
  // `useBranchFetch`) so both selectors share one entry; fall back to repoPath.
  const branchKey = loadBranches ? repoId || repoPath || null : null;

  // ============ GITHUB ============
  const [githubCache, setGithubCache] = useAtom(worktreeGithubCacheAtom);
  const githubCacheRef = useRef(githubCache);
  useEffect(() => {
    githubCacheRef.current = githubCache;
  }, [githubCache]);
  const [githubPending, setGithubPending] = useState(false);
  const [githubLocalError, setGithubLocalError] = useState<string | null>(null);
  const [githubKey, setGithubKey] = useState<string | null>(null);
  const githubGenerationRef = useRef(0);

  const githubEntry =
    githubKey && githubRepoKey && githubKey.endsWith(`|${githubRepoKey}`)
      ? githubCache.get(githubKey)
      : undefined;

  const loadGithub = useCallback(
    async (force: boolean) => {
      if (!repoPath || !githubRepoKey) return;
      const generation = ++githubGenerationRef.current;
      setGithubPending(true);
      setGithubLocalError(null);

      let authScope: string;
      try {
        authScope = await resolveGithubAuthScope();
      } catch (error) {
        if (generation !== githubGenerationRef.current) return;
        setGithubPending(false);
        setGithubLocalError(
          error instanceof Error ? error.message : String(error)
        );
        return;
      }

      if (generation !== githubGenerationRef.current) return;
      const requestKey = resolveWorktreeGithubCacheKey(
        githubRepoKey,
        authScope
      );
      setGithubKey(requestKey);
      setGithubCache((prev) =>
        evictOtherWorktreeGithubIdentities(prev, githubRepoKey, requestKey)
      );
      const existing = githubCacheRef.current.get(requestKey);
      if (
        !force &&
        getWorktreeCacheFreshness(
          existing,
          Date.now(),
          WORKTREE_GITHUB_CACHE_TTL_MS
        ) === "fresh"
      ) {
        setGithubPending(false);
        return;
      }

      try {
        const data = await githubInflight.run(requestKey, () =>
          fetchGithubData(repoId, repoPath)
        );
        const currentAuthScope = await resolveGithubAuthScope();
        if (
          generation !== githubGenerationRef.current ||
          currentAuthScope !== authScope
        ) {
          return;
        }
        const hasItems = data.prs.length + data.issues.length > 0;
        const state =
          data.repoFullName === null ? "empty" : hasItems ? "ready" : "empty";
        setGithubCache((prev) =>
          writeWorktreeCacheEntry(
            evictOtherWorktreeGithubIdentities(prev, githubRepoKey, requestKey),
            requestKey,
            {
              data,
              state,
              error: null,
              fetchedAt: Date.now(),
            }
          )
        );
      } catch (error) {
        if (generation !== githubGenerationRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        // Stale-while-revalidate: keep the previous list on a failed refresh;
        // only record a hard error entry when there is nothing to show.
        setGithubCache((prev) => {
          if (prev.get(requestKey)) return prev;
          return writeWorktreeCacheEntry(prev, requestKey, {
            data: { prs: [], issues: [], repoFullName: null },
            state: "error",
            error: message,
            fetchedAt: Date.now(),
          });
        });
        setGithubLocalError(message);
      } finally {
        if (generation === githubGenerationRef.current) {
          setGithubPending(false);
        }
      }
    },
    [githubRepoKey, repoId, repoPath, setGithubCache]
  );

  useEffect(() => {
    if (!open || !repoPath || !githubRepoKey) return;
    void loadGithub(false);
    return () => {
      githubGenerationRef.current += 1;
    };
  }, [open, githubRepoKey, repoPath, loadGithub]);

  const githubState: WorktreeLoadState = !repoPath
    ? "empty"
    : githubEntry
      ? githubEntry.state
      : "loading";

  const githubError = githubEntry
    ? githubEntry.state === "error"
      ? githubEntry.error
      : null
    : githubLocalError;

  const github = useMemo<WorktreeGithubSlice>(
    () => ({
      prs: githubEntry?.data.prs ?? [],
      issues: githubEntry?.data.issues ?? [],
      repoFullName: githubEntry?.data.repoFullName ?? null,
      state: githubState,
      error: githubError,
      refreshing: githubPending && Boolean(githubEntry),
      refresh: () => void loadGithub(true),
    }),
    [githubEntry, githubState, githubError, githubPending, loadGithub]
  );

  // ============ BRANCHES (reuse app-wide branchCacheAtom) ============
  const [branchCache, setBranchCache] = useAtom(branchCacheAtom);
  const branchCacheRef = useRef(branchCache);
  useEffect(() => {
    branchCacheRef.current = branchCache;
  }, [branchCache]);
  const [branchPending, setBranchPending] = useState(false);
  const [branchErrored, setBranchErrored] = useState(false);
  const [branchErrorMsg, setBranchErrorMsg] = useState<string | null>(null);
  const branchGenerationRef = useRef(0);

  const branchEntry = branchKey
    ? getBranchesFromCache(branchCache, branchKey)
    : null;

  const loadBranch = useCallback(
    async (force: boolean) => {
      if (!repoPath || !branchKey) return;
      const generation = ++branchGenerationRef.current;
      const existing = getBranchesFromCache(branchCacheRef.current, branchKey);
      if (
        !force &&
        existing &&
        existing.branches.length > 0 &&
        isBranchCacheFresh(branchCacheRef.current, branchKey)
      ) {
        return;
      }

      setBranchPending(true);
      setBranchErrored(false);
      setBranchErrorMsg(null);
      try {
        const branches = await branchInflight.run(branchKey, () =>
          fetchBranchList(repoId, repoPath)
        );
        if (generation !== branchGenerationRef.current) return;
        if (branches === undefined) {
          // Keep any stale list; only flag an error when there is none.
          if (!getBranchesFromCache(branchCacheRef.current, branchKey)) {
            setBranchErrored(true);
          }
          return;
        }
        setBranchCache((prev) =>
          setBranchCacheWithLRU(prev, branchKey, {
            branches,
            currentBranch: "",
            fetchedAt: Date.now(),
          })
        );
      } catch (error) {
        if (generation !== branchGenerationRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        if (!getBranchesFromCache(branchCacheRef.current, branchKey)) {
          setBranchErrored(true);
          setBranchErrorMsg(message);
        }
      } finally {
        if (generation === branchGenerationRef.current) {
          setBranchPending(false);
        }
      }
    },
    [branchKey, repoId, repoPath, setBranchCache]
  );

  useEffect(() => {
    if (!open || !repoPath || !branchKey) return;
    void loadBranch(false);
    return () => {
      branchGenerationRef.current += 1;
    };
  }, [open, branchKey, repoPath, loadBranch]);

  const branchOptions = useMemo(
    () =>
      branchEntry
        ? sortBranchOptions(branchCacheEntryToOptions(branchEntry.branches))
        : [],
    [branchEntry]
  );

  const branchState: WorktreeLoadState = !repoPath
    ? "empty"
    : branchEntry
      ? branchOptions.length > 0
        ? "ready"
        : "empty"
      : branchPending
        ? "loading"
        : branchErrored
          ? "error"
          : "loading";

  const branch = useMemo<WorktreeBranchSlice>(
    () => ({
      options: branchOptions,
      state: branchState,
      error: branchErrorMsg,
      refreshing: branchPending && Boolean(branchEntry),
      refresh: () => void loadBranch(true),
    }),
    [
      branchOptions,
      branchState,
      branchErrorMsg,
      branchPending,
      branchEntry,
      loadBranch,
    ]
  );

  return { github, branch };
}

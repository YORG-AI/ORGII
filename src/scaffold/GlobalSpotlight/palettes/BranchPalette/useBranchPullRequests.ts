import { useCallback, useEffect, useRef, useState } from "react";

import { getGitRemotes } from "@src/api/http/git/remotes";
import {
  type OpenPRItem,
  getGitCredentialForRemote,
  listOpenPRsLocal,
} from "@src/api/tauri/github";
import { coalesceGitHubListRequest } from "@src/services/git/githubListCache";
import { resolveGithubRepoFullName } from "@src/util/git/githubRemote";

const BRANCH_PICKER_PR_PAGE_SIZE = 50;
export const BRANCH_PICKER_PR_LIMIT = 500;
const MAX_PAGES = BRANCH_PICKER_PR_LIMIT / BRANCH_PICKER_PR_PAGE_SIZE;
const GITHUB_ENDPOINT = "https://github.com";

async function authScope(): Promise<string> {
  const credential = await getGitCredentialForRemote(GITHUB_ENDPOINT);
  return JSON.stringify([
    GITHUB_ENDPOINT,
    credential?.connection_id,
    credential?.source,
    credential?.username,
  ]);
}

function fetchPage(identity: string, repoFullName: string, page: number) {
  return coalesceGitHubListRequest(
    JSON.stringify(["branch-picker-prs", identity, repoFullName, page]),
    () =>
      listOpenPRsLocal(repoFullName, BRANCH_PICKER_PR_PAGE_SIZE, {
        page,
        // One batched check rollup per page, shared with the PR list request.
        includeMetadata: true,
      })
  );
}

interface PullRequestState {
  scope: string;
  identity: string;
  prs: OpenPRItem[];
  remote: string | null;
  repoFullName: string | null;
  nextPage: number;
  hasMore: boolean;
  limitReached: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMoreError: string | null;
}

/** Open-picker state only: 50 per request, at most 10 pages, no polling/cache. */
export function useBranchPullRequests(repoId: string, repoPath: string) {
  const scope = JSON.stringify([repoId, repoPath]);
  const [state, setState] = useState<PullRequestState | null>(null);
  const [revision, setRevision] = useState(0);
  const generationRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const refresh = useCallback(() => {
    generationRef.current += 1;
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    let disposed = false;
    async function load() {
      const generation = ++generationRef.current;
      loadingMoreRef.current = false;
      const active = () => !disposed && generation === generationRef.current;
      const initial: PullRequestState = {
        scope,
        identity: "",
        prs: [],
        remote: null,
        repoFullName: null,
        nextPage: 1,
        hasMore: false,
        limitReached: false,
        loading: true,
        loadingMore: false,
        error: null,
        loadMoreError: null,
      };
      setState(initial);
      if (document.visibilityState === "hidden") return;
      try {
        if (!repoPath) {
          setState({ ...initial, loading: false });
          return;
        }
        const remotes = await getGitRemotes({
          repo_id: repoId,
          repo_path: repoPath,
        });
        if (!active()) return;
        if (!remotes) throw new Error("Could not read repository remotes");
        const githubRemotes = remotes.remotes.filter((remote) =>
          resolveGithubRepoFullName([remote.url])
        );
        const remote =
          githubRemotes.find((candidate) => candidate.name === "origin") ??
          githubRemotes[0];
        const repoFullName = remote
          ? resolveGithubRepoFullName([remote.url])
          : null;
        if (!repoFullName || !remote) {
          setState({ ...initial, loading: false });
          return;
        }
        const identity = await authScope();
        if (!active()) return;
        const prs = await fetchPage(identity, repoFullName, 1);
        if (!active()) return;
        if (identity !== (await authScope())) {
          if (active()) refresh();
          return;
        }
        if (active())
          setState({
            ...initial,
            identity,
            repoFullName,
            remote: remote.name,
            loading: false,
            prs: prs.slice(0, BRANCH_PICKER_PR_PAGE_SIZE),
            nextPage: 2,
            hasMore: prs.length >= BRANCH_PICKER_PR_PAGE_SIZE,
          });
      } catch (error) {
        if (active())
          setState({
            ...initial,
            loading: false,
            error: String(error instanceof Error ? error.message : error),
          });
      }
    }
    void load();
    const onVisibility = () => void load();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      generationRef.current += 1;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [repoId, repoPath, scope, revision, refresh]);

  const loadMore = useCallback(async () => {
    if (
      !state ||
      state.scope !== scope ||
      !state.repoFullName ||
      state.loading ||
      !state.hasMore ||
      loadingMoreRef.current ||
      document.visibilityState === "hidden"
    )
      return;
    loadingMoreRef.current = true;
    const generation = generationRef.current;
    const active = () => generation === generationRef.current;
    setState({ ...state, loadingMore: true, loadMoreError: null });
    try {
      // Detect account changes between pages as well as during a request.
      if (state.identity !== (await authScope())) {
        if (active()) refresh();
        return;
      }
      if (!active()) return;
      const page = state.nextPage;
      const result = await fetchPage(state.identity, state.repoFullName, page);
      if (!active()) return;
      if (state.identity !== (await authScope())) {
        if (active()) refresh();
        return;
      }
      if (!active()) return;
      // Updated ordering can shift between pages. Deduplicate by PR identity,
      // retain the freshest payload, and cap pages even if all overlap.
      const byNumber = new Map(state.prs.map((pr) => [pr.number, pr]));
      for (const pr of result.slice(0, BRANCH_PICKER_PR_PAGE_SIZE)) {
        const existing = byNumber.get(pr.number);
        if (!existing || pr.updated_at > existing.updated_at)
          byNumber.set(pr.number, pr);
      }
      const fullPage = result.length >= BRANCH_PICKER_PR_PAGE_SIZE;
      setState({
        ...state,
        prs: [...byNumber.values()].slice(0, BRANCH_PICKER_PR_LIMIT),
        nextPage: page + 1,
        hasMore: fullPage && page < MAX_PAGES,
        limitReached: fullPage && page === MAX_PAGES,
        loadingMore: false,
        loadMoreError: null,
      });
    } catch (error) {
      if (active())
        setState({
          ...state,
          loadingMore: false,
          loadMoreError: String(error instanceof Error ? error.message : error),
        });
    } finally {
      if (active()) loadingMoreRef.current = false;
    }
  }, [state, scope, refresh]);

  const current = state?.scope === scope ? state : null;
  return {
    prs: current?.prs ?? [],
    remote: current?.remote ?? null,
    repoFullName: current?.repoFullName ?? null,
    loading: !current || current.loading,
    error: current?.error ?? null,
    loadingMore: current?.loadingMore ?? false,
    loadMoreError: current?.loadMoreError ?? null,
    hasMore: current?.hasMore ?? false,
    limitReached: current?.limitReached ?? false,
    refresh,
    loadMore,
  };
}

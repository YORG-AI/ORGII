/**
 * Keeps the sidebar's per-repo PR snapshots warm and hands rows an O(1)
 * lookup.
 *
 * Deliberately conservative about work:
 *  - only the {@link MAX_SESSIONS_SCANNED} most recent rows contribute repos,
 *    so a fully paginated sidebar does not widen the fetch;
 *  - repos are capped, deduped, and fetched once each (two list calls), never
 *    once per session;
 *  - a repo is refetched only when its snapshot ages past the TTL, and the
 *    interval tick is skipped entirely while the window is hidden;
 *  - repos that scroll out of the considered set are pruned from the cache.
 */
import { useAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { listPRsLocal } from "@src/api/tauri/github/pullRequests";
import { createLogger } from "@src/hooks/logger";
import {
  type BranchPrSnapshot,
  PR_STATUS_CACHE_CONFIG,
  buildRepoPrSnapshot,
  isRepoPrStatusStale,
  pruneRepoPrStatusCache,
  repoPrStatusCacheAtom,
} from "@src/store/git";
import type { Session } from "@src/store/session";
import { resolveGithubRepoFullName } from "@src/util/git/githubRemote";
import { resolveSessionGitLink } from "@src/util/session/sessionGitLink";

const logger = createLogger("useSessionPrStatuses");

/**
 * Rows are already newest-first, so the head of the list is what a user
 * actually looks at. Older rows still render their branch glyph — they just
 * do not pull a repo into the fetch set on their own.
 */
const MAX_SESSIONS_SCANNED = 30;

export type SessionPrLookup = (
  session: Session
) => BranchPrSnapshot | undefined;

const NO_PR: SessionPrLookup = () => undefined;

export function useSessionPrStatuses(
  sessions: readonly Session[]
): SessionPrLookup {
  const [cache, setCache] = useAtom(repoPrStatusCacheAtom);
  const inFlightRef = useRef(new Set<string>());
  const cacheRef = useRef(cache);
  cacheRef.current = cache;

  const activeRepos = useMemo(() => {
    const repos = new Set<string>();
    for (const session of sessions.slice(0, MAX_SESSIONS_SCANNED)) {
      // A session with no branch can never match a PR, so it must not be the
      // reason a repo gets fetched.
      if (!resolveSessionGitLink(session)) continue;
      const repoFullName = resolveGithubRepoFullName(session.repoRemoteUrls);
      if (!repoFullName) continue;
      repos.add(repoFullName);
      if (repos.size >= PR_STATUS_CACHE_CONFIG.MAX_REPOS) break;
    }
    return repos;
  }, [sessions]);

  // Stable across renders that produce the same repo set, so the refresh
  // interval is not torn down every time the session list re-sorts.
  const activeReposKey = useMemo(
    () => [...activeRepos].sort().join(","),
    [activeRepos]
  );

  const refresh = useCallback(async () => {
    const repos = activeReposKey ? activeReposKey.split(",") : [];
    const repoSet = new Set(repos);

    setCache((current) => {
      const pruned = pruneRepoPrStatusCache(current, repoSet);
      return pruned.size === current.size ? current : pruned;
    });

    const now = Date.now();
    const stale = repos.filter(
      (repoFullName) =>
        !inFlightRef.current.has(repoFullName) &&
        isRepoPrStatusStale(cacheRef.current.get(repoFullName), now)
    );

    await Promise.all(
      stale.map(async (repoFullName) => {
        inFlightRef.current.add(repoFullName);
        try {
          const [open, closed] = await Promise.all([
            listPRsLocal(
              repoFullName,
              "open",
              PR_STATUS_CACHE_CONFIG.PAGE_SIZE
            ),
            listPRsLocal(
              repoFullName,
              "closed",
              PR_STATUS_CACHE_CONFIG.PAGE_SIZE
            ),
          ]);
          const snapshot = buildRepoPrSnapshot({ open, closed });
          setCache((current) => new Map(current).set(repoFullName, snapshot));
        } catch (error) {
          // A repo the user cannot read (no GitHub connection, private fork,
          // rate limit) must not be retried on every tick.
          logger.warn("failed to load pull requests", { error, repoFullName });
          setCache((current) =>
            new Map(current).set(repoFullName, {
              fetchedAt: Date.now(),
              byBranch: new Map(),
              error: true,
              retryAt: Date.now() + PR_STATUS_CACHE_CONFIG.ERROR_RETRY_MS,
            })
          );
        } finally {
          inFlightRef.current.delete(repoFullName);
        }
      })
    );
  }, [activeReposKey, setCache]);

  useEffect(() => {
    if (!activeReposKey) return;
    void refresh();
    const timer = setInterval(() => {
      // Nothing on screen to update — let the next visible tick do the work.
      if (typeof document !== "undefined" && document.hidden) return;
      void refresh();
    }, PR_STATUS_CACHE_CONFIG.TTL_MS);
    return () => clearInterval(timer);
  }, [activeReposKey, refresh]);

  return useMemo<SessionPrLookup>(() => {
    if (cache.size === 0) return NO_PR;
    return (session) => {
      const link = resolveSessionGitLink(session);
      if (!link) return undefined;
      const repoFullName = resolveGithubRepoFullName(session.repoRemoteUrls);
      if (!repoFullName) return undefined;
      // Match on the raw branch ref: `formatBranchLabel` strips the `agent/`
      // worktree prefix for display, but GitHub knows the branch by its real
      // name.
      const headBranch =
        session.worktreeBranch || session.branch || session.baseBranch;
      if (!headBranch) return undefined;
      return cache
        .get(repoFullName)
        ?.byBranch.get(headBranch.replace(/^refs\/heads\//, ""));
    };
  }, [cache]);
}

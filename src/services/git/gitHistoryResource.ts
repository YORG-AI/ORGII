import { getGitCommits } from "@src/api/http/git/commits";
import type { GitCommitInfo } from "@src/api/http/git/types";

import {
  ScopedResourceCache,
  type ScopedResourceCacheStats,
} from "./scopedResourceCache";

const HISTORY_CACHE_MAX_ENTRIES = 6;
const HISTORY_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const HISTORY_CACHE_MAX_ENTRY_BYTES = 512 * 1024;
const HISTORY_CACHE_MAX_COMMITS = 200;
const HISTORY_CACHE_MAX_AGE_MS = 15_000;

export interface GitHistoryRequest {
  limit: number;
  repoId: string;
  repoPath: string;
}

export interface GitHistorySnapshot {
  commits: GitCommitInfo[];
  hasMore: boolean;
}

function historyKey(request: GitHistoryRequest): string {
  return JSON.stringify([request.repoId, request.repoPath, request.limit]);
}

function estimateHistoryBytes(snapshot: GitHistorySnapshot): number {
  return snapshot.commits.reduce(
    (total, commit) =>
      total +
      (commit.sha.length +
        commit.short_sha.length +
        commit.summary.length +
        commit.body.length +
        commit.author.name.length +
        commit.author.email.length +
        commit.author.date.length +
        commit.committer.name.length +
        commit.committer.email.length +
        commit.committer.date.length +
        commit.parent_shas.join("").length) *
        2 +
      256,
    64
  );
}

function boundedSnapshot(snapshot: GitHistorySnapshot): GitHistorySnapshot {
  const commits = snapshot.commits.slice(0, HISTORY_CACHE_MAX_COMMITS);
  return {
    commits,
    hasMore:
      snapshot.hasMore || snapshot.commits.length > HISTORY_CACHE_MAX_COMMITS,
  };
}

const historyCache = new ScopedResourceCache<GitHistorySnapshot>({
  estimateSize: estimateHistoryBytes,
  maxAgeMs: HISTORY_CACHE_MAX_AGE_MS,
  maxBytes: HISTORY_CACHE_MAX_BYTES,
  maxEntries: HISTORY_CACHE_MAX_ENTRIES,
  maxEntryBytes: HISTORY_CACHE_MAX_ENTRY_BYTES,
});

export function getCachedGitHistory(
  request: GitHistoryRequest
): GitHistorySnapshot | null {
  return historyCache.get(historyKey(request))?.value ?? null;
}

export function loadGitHistory(
  request: GitHistoryRequest,
  options: { force?: boolean } = {}
): Promise<GitHistorySnapshot> {
  const key = historyKey(request);
  return historyCache.load(
    key,
    async () => {
      const result = await getGitCommits({
        repo_id: request.repoId,
        repo_path: request.repoPath,
        limit: request.limit,
      });
      if (!result?.commits) {
        throw new Error("Failed to load commit history");
      }
      return boundedSnapshot({
        commits: result.commits,
        hasMore: result.commits.length >= request.limit,
      });
    },
    options
  );
}

export function writeGitHistoryCache(
  request: GitHistoryRequest,
  snapshot: GitHistorySnapshot
): void {
  historyCache.set(historyKey(request), boundedSnapshot(snapshot));
}

export function getGitHistoryResourceStats(): ScopedResourceCacheStats {
  return historyCache.getStats();
}

export function resetGitHistoryResourceForTests(): void {
  historyCache.clear();
}

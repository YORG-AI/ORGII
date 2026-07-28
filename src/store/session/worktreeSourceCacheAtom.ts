/**
 * Worktree-source GitHub cache atom
 *
 * Caches the WorktreeSourceModal's GitHub PR/issue data per auth + repo key so
 * switching tabs / reopening the modal within the TTL window reuses the
 * result instead of re-fetching + spinning. The key combines the authenticated
 * GitHub connection identity with `resolveWorktreeRepoKey`, preventing private
 * data from leaking across account switches.
 *
 * Raw PR/issue payloads are cached (not the rendered rows) so the cache stays
 * serializable and the Smart tab can derive its own view from the same data.
 * Branch data is NOT cached here — it reuses the app-wide `branchCacheAtom`
 * (`@src/store/repo`), shared with `BranchPalette`.
 *
 * TTL + LRU eviction is applied by the pure helpers in
 * `worktreeSourceCache.ts`; this module only holds the atom + its types.
 */
import { atom } from "jotai";

import type { GitHubIssue, OpenPRItem } from "@src/api/tauri/github";

/** Cached GitHub payload for one repo (already de-duped: issues exclude PRs). */
export interface WorktreeGithubData {
  prs: OpenPRItem[];
  /** Issues that are not also PRs (GitHub returns PRs in the issues list). */
  issues: GitHubIssue[];
  /** Parsed `owner/name` of the origin remote, or `null` when not a GitHub repo. */
  repoFullName: string | null;
}

/** Terminal load state stored alongside cached data. */
export type WorktreeGithubEntryState = "ready" | "empty" | "error";

/** One repo's cached GitHub entry with freshness metadata. */
export interface WorktreeGithubCacheEntry {
  data: WorktreeGithubData;
  state: WorktreeGithubEntryState;
  error: string | null;
  fetchedAt: number;
}

/** Map keyed by auth scope + repo key → cached GitHub entry. */
export const worktreeGithubCacheAtom = atom<
  Map<string, WorktreeGithubCacheEntry>
>(new Map());
worktreeGithubCacheAtom.debugLabel = "worktreeGithubCacheAtom";

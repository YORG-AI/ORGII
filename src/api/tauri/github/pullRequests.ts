/**
 * GitHub API — pull requests (create, list, find, get, commits, base
 * resolution). See `./pullRequestReviews` for files/content/reviews/checks.
 */
import { invoke } from "@tauri-apps/api/core";

import { appendPullRequestAttributionFooter } from "@src/services/git/operations/commitAttribution";

import { invokeWithAuth } from "./client";
import type { LocalFindPRResponse, LocalPRResponse } from "./types";

export async function createPRLocal(
  repoFullName: string,
  title: string,
  head: string,
  base: string,
  body?: string,
  draft?: boolean
): Promise<LocalPRResponse> {
  return invokeWithAuth<LocalPRResponse>("github_create_pr", {
    repoFullName,
    title,
    head,
    base,
    body: appendPullRequestAttributionFooter(body),
    draft: draft ?? null,
  });
}

export interface OpenPRItem {
  number: number;
  url: string;
  title: string;
  state: string;
  head_branch: string;
  base_branch: string;
  draft: boolean;
  created_at: string;
  updated_at: string;
}

export type PullRequestListState = "open" | "closed";

export async function listPRsLocal(
  repoFullName: string,
  state: PullRequestListState,
  perPage?: number
): Promise<OpenPRItem[]> {
  return invokeWithAuth<OpenPRItem[]>("github_list_prs", {
    repoFullName,
    state,
    perPage: perPage ?? null,
  });
}

export async function listOpenPRsLocal(
  repoFullName: string,
  perPage?: number
): Promise<OpenPRItem[]> {
  return listPRsLocal(repoFullName, "open", perPage);
}

/**
 * Which fetch strategy the backend used to resolve a PR head into a SHA.
 * Mirrors the Rust `PrBaseSource` enum (serialized camelCase).
 */
export type PrBaseSource = "branch" | "pullRef";

/**
 * Result of resolving a GitHub PR into a git-resolvable base ref. Mirrors the
 * Rust `PrBaseResolution`.
 */
export interface PrBaseResolution {
  /** Git-resolvable commit-ish (PR head SHA) for `git worktree add … <base>`. */
  baseRef: string;
  /** PR head commit SHA (identical to `baseRef`). */
  headSha: string;
  /** PR head branch name, when known — a label hint, not a git base. */
  branchNameOverride: string | null;
  /** `refs/remotes/<remote>/<base>` when a base branch was supplied. */
  compareBaseRef: string | null;
  /** `branch` = same-repo head fetch, `pullRef` = fork / `refs/pull/<n>/head`. */
  source: PrBaseSource;
}

/**
 * Resolve a GitHub PR (including fork / cross-repo PRs) into a concrete,
 * git-resolvable base ref by fetching its head into the local repo.
 *
 * Tries `git fetch <remote> <headBranch>` first, falling back to
 * `git fetch <remote> refs/pull/<prNumber>/head` for fork PRs whose head
 * branch is not on the base remote. Returns the head SHA as `baseRef`, ready
 * to feed the isolated-worktree launch path.
 */
export async function resolvePrWorktreeBase(params: {
  repoPath: string;
  prNumber: number;
  remote?: string;
  headBranch?: string;
  baseBranch?: string;
}): Promise<PrBaseResolution> {
  return invoke<PrBaseResolution>("worktree_resolve_pr_base", {
    repoPath: params.repoPath,
    prNumber: params.prNumber,
    remote: params.remote ?? null,
    headBranch: params.headBranch ?? null,
    baseBranch: params.baseBranch ?? null,
  });
}

export async function findPullRequestLocal(
  repoFullName: string,
  headBranch: string
): Promise<LocalFindPRResponse | null> {
  return invokeWithAuth<LocalFindPRResponse | null>(
    "github_find_pull_request",
    {
      repoFullName,
      headBranch,
    }
  );
}

export async function getPRLocal(
  repoFullName: string,
  prNumber: number
): Promise<Record<string, unknown>> {
  return invokeWithAuth<Record<string, unknown>>("github_get_pr", {
    repoFullName,
    prNumber,
  });
}

export async function listPRCommitsLocal(
  repoFullName: string,
  prNumber: number
): Promise<Record<string, unknown>[]> {
  const data = await invokeWithAuth<unknown>("github_list_pr_commits", {
    repoFullName,
    prNumber,
  });
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

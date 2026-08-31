/**
 * Git Branches API
 *
 * Branch listing and information functions.
 */
import { createLogger } from "@src/hooks/logger";

import {
  branchRequestCache,
  cleanupCache,
  fetchRustApi,
  gitRepoUrl,
} from "./client";
import type {
  GitAheadBehind,
  GitBranchInfo,
  GitBranchesResponse,
} from "./types";

const log = createLogger("GitAPI");

/**
 * Get all branches (local and optionally remote) - with request deduplication
 * Uses Rust HTTP server for better performance
 */
export const getGitBranches = async (params: {
  repo_id: string;
  repo_path?: string;
  include_remote?: boolean;
}): Promise<GitBranchesResponse["data"] | undefined> => {
  // Include repo_path: a main-checkout and a worktree request for the same
  // repo id must not share one in-flight response.
  const cacheKey = `${params.repo_id}-${params.repo_path ?? ""}-${params.include_remote ?? true}`;

  // Return existing promise if request is already in-flight
  if (branchRequestCache.has(cacheKey)) {
    return branchRequestCache.get(cacheKey) as Promise<
      GitBranchesResponse["data"] | undefined
    >;
  }

  // Build query params
  const queryParams = new URLSearchParams();
  if (params.repo_path) {
    queryParams.append("path", params.repo_path);
  }

  // Make new request to Rust HTTP server
  const promise = fetchRustApi<GitBranchesResponse["data"]>(
    `${gitRepoUrl(params.repo_id)}/branches${queryParams.toString() ? `?${queryParams.toString()}` : ""}`
  )
    .then((response) => response.data)
    .catch((error) => {
      log.error("[GitAPI] Failed to fetch branches from Rust server:", error);
      return undefined;
    })
    .finally(() => cleanupCache(branchRequestCache, cacheKey));

  branchRequestCache.set(cacheKey, promise);
  return promise;
};

/**
 * Get current branch with full info (SLOW - loads all branches first)
 * Uses Rust HTTP server
 *
 * For startup/status bar, use getGitCurrentBranchName instead (fast path)
 */
export const getGitCurrentBranch = async (params: {
  repo_id: string;
  repo_path?: string;
}): Promise<GitBranchInfo | undefined> => {
  const queryParams = new URLSearchParams();
  if (params.repo_path) {
    queryParams.append("path", params.repo_path);
  }

  try {
    const response = await fetchRustApi<GitBranchInfo>(
      `${gitRepoUrl(params.repo_id)}/current-branch${queryParams.toString() ? `?${queryParams.toString()}` : ""}`
    );
    return response.data;
  } catch (error) {
    log.error(
      "[GitAPI] Failed to fetch current branch from Rust server:",
      error
    );
    return undefined;
  }
};

/**
 * Get current branch name only (FAST - does not load full branch list)
 * Uses Rust HTTP server
 *
 * Preferred for: startup, status bar, quick checks
 * Use getGitBranches when you need the full branch list (e.g., branch dropdown)
 */
export const getGitCurrentBranchName = async (params: {
  repo_id: string;
  repo_path?: string;
}): Promise<string | undefined> => {
  const queryParams = new URLSearchParams();
  if (params.repo_path) {
    queryParams.append("path", params.repo_path);
  }

  try {
    const response = await fetchRustApi<{ name: string }>(
      `${gitRepoUrl(params.repo_id)}/current-branch-name${queryParams.toString() ? `?${queryParams.toString()}` : ""}`
    );
    return response.data.name;
  } catch (error) {
    log.error(
      "[GitAPI] Failed to fetch current branch name from Rust server:",
      error
    );
    return undefined;
  }
};

/**
 * Get ahead/behind counts for a branch
 * Uses Rust HTTP server
 */
export const getGitAheadBehind = async (params: {
  repo_id: string;
  repo_path?: string;
  branch?: string;
}): Promise<GitAheadBehind | undefined> => {
  const queryParams = new URLSearchParams();
  if (params.repo_path) queryParams.append("path", params.repo_path);
  if (params.branch) queryParams.append("branch", params.branch);

  try {
    const response = await fetchRustApi<GitAheadBehind>(
      `${gitRepoUrl(params.repo_id)}/ahead-behind${queryParams.toString() ? `?${queryParams.toString()}` : ""}`
    );
    return response.data;
  } catch (error) {
    log.error("[GitAPI] Failed to fetch ahead/behind from Rust server:", error);
    return undefined;
  }
};

/**
 * Get default branch of the repository
 * Uses Rust HTTP server
 */
export const getGitDefaultBranch = async (params: {
  repo_id: string;
  repo_path?: string;
  remote?: string;
}): Promise<{ name: string } | undefined> => {
  const queryParams = new URLSearchParams();
  if (params.repo_path) queryParams.append("path", params.repo_path);
  if (params.remote) queryParams.append("remote", params.remote);

  try {
    const response = await fetchRustApi<{ name: string }>(
      `${gitRepoUrl(params.repo_id)}/default-branch${queryParams.toString() ? `?${queryParams.toString()}` : ""}`
    );
    return response.data;
  } catch (error) {
    log.error(
      "[GitAPI] Failed to fetch default branch from Rust server:",
      error
    );
    return undefined;
  }
};

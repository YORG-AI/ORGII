/**
 * Git Remote Operations API
 *
 * Fetch, pull, and push operations.
 */
import { announceBranchRemoteMutation } from "@src/util/git/branchRemoteMutation";

import { fetchRustApi, gitRepoUrl } from "./client";
import type { GitErrorType } from "./streaming";
import type { GitOperationResponse, GitPullResponse } from "./types";

class GitRemoteOperationError extends Error {
  readonly errorType: GitErrorType;

  constructor(message: string, errorType: GitErrorType) {
    super(message);
    this.name = "GitRemoteOperationError";
    this.errorType = errorType;
  }
}

function throwGitRemoteOperationError(
  result: { message?: string; error_type?: GitErrorType },
  fallbackMessage: string
): never {
  throw new GitRemoteOperationError(
    result.message || fallbackMessage,
    result.error_type ?? "unknown"
  );
}

/**
 * Fetch updates from remote
 * Uses Rust HTTP server for better performance
 */
export const gitFetch = async (params: {
  repo_id: string;
  repo_path?: string;
  remote?: string;
  prune?: boolean;
  authUsername?: string;
  authToken?: string;
  storeAuth?: boolean;
}): Promise<GitOperationResponse["data"]> => {
  const queryParams = new URLSearchParams();
  if (params.repo_path) queryParams.append("path", params.repo_path);

  const response = await fetchRustApi<GitOperationResponse["data"]>(
    `${gitRepoUrl(params.repo_id)}/fetch${queryParams.toString() ? `?${queryParams.toString()}` : ""}`,
    {
      method: "POST",
      body: JSON.stringify({
        remote: params.remote ?? "origin",
        // Prune deletes local remote-tracking refs; a destructive flag must
        // be sent only when the caller explicitly asked for it. (The Rust
        // handler's own default is prune=true when the field is absent, so
        // the explicit false here is load-bearing.)
        prune: params.prune ?? false,
        auth_username: params.authUsername ?? null,
        auth_token: params.authToken ?? null,
        store_auth: params.storeAuth ?? false,
      }),
    }
  );

  const result = response.data;

  // Check if fetch actually succeeded
  if (result && !result.success) {
    throwGitRemoteOperationError(result, "Fetch failed");
  }

  return result;
};

/**
 * Pull updates from remote (fetch + merge/rebase)
 * Uses Rust HTTP server for better performance
 */
export const gitPull = async (params: {
  repo_id: string;
  repo_path?: string;
  remote?: string;
  branch?: string;
  strategy?: string;
  authUsername?: string;
  authToken?: string;
  storeAuth?: boolean;
}): Promise<GitPullResponse["data"]> => {
  const queryParams = new URLSearchParams();
  if (params.repo_path) queryParams.append("path", params.repo_path);

  const response = await fetchRustApi<GitPullResponse["data"]>(
    `${gitRepoUrl(params.repo_id)}/pull${queryParams.toString() ? `?${queryParams.toString()}` : ""}`,
    {
      method: "POST",
      body: JSON.stringify({
        remote: params.remote ?? "origin",
        branch: params.branch ?? null,
        strategy: params.strategy ?? null,
        auth_username: params.authUsername ?? null,
        auth_token: params.authToken ?? null,
        store_auth: params.storeAuth ?? false,
      }),
    }
  );

  const result = response.data;

  // Check if pull actually succeeded
  if (result && !result.success) {
    throwGitRemoteOperationError(result, "Pull failed");
  }

  return result;
};

/**
 * Push commits to remote
 * Uses Rust HTTP server for better performance
 */
export const gitPush = async (params: {
  repo_id: string;
  repo_path?: string;
  remote?: string;
  branch?: string;
  set_upstream?: boolean;
  force?: boolean;
  authUsername?: string;
  authToken?: string;
  storeAuth?: boolean;
}): Promise<GitOperationResponse["data"]> => {
  const queryParams = new URLSearchParams();
  if (params.repo_path) queryParams.append("path", params.repo_path);

  const response = await fetchRustApi<GitOperationResponse["data"]>(
    `${gitRepoUrl(params.repo_id)}/push${queryParams.toString() ? `?${queryParams.toString()}` : ""}`,
    {
      method: "POST",
      body: JSON.stringify({
        remote: params.remote ?? "origin",
        branch: params.branch ?? null,
        set_upstream: params.set_upstream ?? false,
        force: params.force ?? false,
        auth_username: params.authUsername ?? null,
        auth_token: params.authToken ?? null,
        store_auth: params.storeAuth ?? false,
      }),
    }
  );

  const result = response.data;

  // Check if push actually succeeded
  if (result && !result.success) {
    throwGitRemoteOperationError(result, "Push failed");
  }

  announceBranchRemoteMutation({
    repoId: params.repo_id,
    repoPath: params.repo_path,
    branchName: params.branch,
    reason: "push",
  });

  return result;
};

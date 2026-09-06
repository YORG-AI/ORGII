/**
 * Git Streaming Operations
 *
 * SSE-based streaming for git push, pull, fetch operations.
 * Provides real-time output from git commands via Server-Sent Events.
 */
import { createSSEStream } from "@src/api/realtime/sseStream";
import { shouldIncludeGitCoauthor } from "@src/services/git/operations/commitAttribution";

import { gitRepoUrl } from "./client";

/**
 * Git error types detected by the backend
 * These map to specific dialogs in the frontend
 */
export type GitErrorType =
  | "none"
  | "non_fast_forward" // Push rejected - remote has changes
  | "protected_branch" // Target branch is protected
  | "authentication_failed" // Auth failed
  | "remote_branch_deleted" // Remote branch was deleted
  | "uncommitted_changes" // Local changes would be overwritten
  | "network_error" // Network/connection error
  | "merge_conflicts" // Merge conflicts
  | "permission_denied" // Permission denied
  | "unknown"; // Unknown error

export interface GitStreamCallbacks {
  onStart?: () => void;
  onOutput?: (line: string, stream: "stdout" | "stderr") => void;
  /** Called when operation completes with success status and error type */
  onComplete?: (success: boolean, errorType?: GitErrorType) => void;
  onError?: (error: string, errorType?: GitErrorType) => void;
}

/**
 * Stream git push output in real-time
 *
 * @example
 * ```typescript
 * const cleanup = await gitPushStream(
 *   {
 *     repo_id: "my-repo",
 *     repo_path: "/path/to/repo",
 *     remote: "origin",
 *     set_upstream: true,
 *   },
 *   {
 *     onOutput: (line, stream) => *
 * // Cancel if needed
 * cleanup();
 * ```
 */
export async function gitPushStream(
  params: {
    repo_id: string;
    repo_path: string;
    remote?: string;
    branch?: string;
    set_upstream?: boolean;
    force?: boolean;
  },
  callbacks: GitStreamCallbacks
): Promise<() => void> {
  const queryParams = new URLSearchParams({
    path: params.repo_path,
  });

  if (params.remote) queryParams.append("remote", params.remote);
  if (params.branch) queryParams.append("branch", params.branch);
  if (params.set_upstream) queryParams.append("set_upstream", "true");
  if (params.force) queryParams.append("force", "true");

  const url = `${gitRepoUrl(params.repo_id)}/push/stream?${queryParams.toString()}`;

  return createSSEStream({
    url,
    onStart: () => {
      callbacks.onStart?.();
    },
    onOutput: (data) => {
      callbacks.onOutput?.(data.line, data.stream as "stdout" | "stderr");
    },
    onEnd: (data) => {
      const errorType = (data.error_type as GitErrorType) || "none";
      callbacks.onComplete?.(data.success, errorType);
    },
    onError: (error, data) => {
      const errorType = (data?.error_type as GitErrorType) || "unknown";
      callbacks.onError?.(error, errorType);
    },
  });
}

/**
 * Stream git pull output in real-time
 *
 * @example
 * ```typescript
 * const cleanup = await gitPullStream(
 *   {
 *     repo_id: "my-repo",
 *     repo_path: "/path/to/repo",
 *     remote: "origin",
 *   },
 *   {
 *     onOutput: (line) => * ```
 */
export async function gitPullStream(
  params: {
    repo_id: string;
    repo_path: string;
    remote?: string;
    branch?: string;
    strategy?: string;
  },
  callbacks: GitStreamCallbacks
): Promise<() => void> {
  const queryParams = new URLSearchParams({
    path: params.repo_path,
  });

  if (params.remote) queryParams.append("remote", params.remote);
  if (params.branch) queryParams.append("branch", params.branch);
  if (params.strategy) queryParams.append("strategy", params.strategy);

  const url = `${gitRepoUrl(params.repo_id)}/pull/stream?${queryParams.toString()}`;

  return createSSEStream({
    url,
    onStart: () => callbacks.onStart?.(),
    onOutput: (data) =>
      callbacks.onOutput?.(data.line, data.stream as "stdout" | "stderr"),
    onEnd: (data) => {
      const errorType = (data.error_type as GitErrorType) || "none";
      callbacks.onComplete?.(data.success, errorType);
    },
    onError: (error, data) => {
      const errorType = (data?.error_type as GitErrorType) || "unknown";
      callbacks.onError?.(error, errorType);
    },
  });
}

/**
 * Stream git fetch output in real-time
 *
 * @example
 * ```typescript
 * const cleanup = await gitFetchStream(
 *   {
 *     repo_id: "my-repo",
 *     repo_path: "/path/to/repo",
 *     remote: "origin",
 *   },
 *   {
 *     onOutput: (line) => * ```
 */
export async function gitFetchStream(
  params: {
    repo_id: string;
    repo_path: string;
    remote?: string;
    prune?: boolean;
    refspec?: string;
  },
  callbacks: GitStreamCallbacks
): Promise<() => void> {
  const queryParams = new URLSearchParams({
    path: params.repo_path,
  });

  if (params.remote) queryParams.append("remote", params.remote);
  if (params.prune !== undefined)
    queryParams.append("prune", params.prune.toString());
  if (params.refspec) queryParams.append("refspec", params.refspec);

  const url = `${gitRepoUrl(params.repo_id)}/fetch/stream?${queryParams.toString()}`;

  return createSSEStream({
    url,
    onStart: () => callbacks.onStart?.(),
    onOutput: (data) =>
      callbacks.onOutput?.(data.line, data.stream as "stdout" | "stderr"),
    onEnd: (data) => {
      const errorType = (data.error_type as GitErrorType) || "none";
      callbacks.onComplete?.(data.success, errorType);
    },
    onError: (error, data) => {
      const errorType = (data?.error_type as GitErrorType) || "unknown";
      callbacks.onError?.(error, errorType);
    },
  });
}

/**
 * Stream git commit output in real-time
 */
export async function gitCommitStream(
  params: {
    repo_id: string;
    repo_path: string;
    message: string;
    coauthor?: boolean;
  },
  callbacks: GitStreamCallbacks
): Promise<() => void> {
  const queryParams = new URLSearchParams({
    path: params.repo_path,
    message: params.message,
    coauthor: String(params.coauthor ?? shouldIncludeGitCoauthor()),
  });

  const url = `${gitRepoUrl(params.repo_id)}/commit/stream?${queryParams.toString()}`;

  return createSSEStream({
    url,
    onStart: () => callbacks.onStart?.(),
    onOutput: (data) =>
      callbacks.onOutput?.(data.line, data.stream as "stdout" | "stderr"),
    onEnd: (data) => {
      const errorType = (data.error_type as GitErrorType) || "none";
      callbacks.onComplete?.(data.success, errorType);
    },
    onError: (error, data) => {
      const errorType = (data?.error_type as GitErrorType) || "unknown";
      callbacks.onError?.(error, errorType);
    },
  });
}

/**
 * Stream git add (stage) output in real-time
 */
export async function gitStageStream(
  params: {
    repo_id: string;
    repo_path: string;
    files: string[];
  },
  callbacks: GitStreamCallbacks
): Promise<() => void> {
  const queryParams = new URLSearchParams({
    path: params.repo_path,
    files: JSON.stringify(params.files),
  });

  const url = `${gitRepoUrl(params.repo_id)}/stage/stream?${queryParams.toString()}`;

  return createSSEStream({
    url,
    onStart: () => callbacks.onStart?.(),
    onOutput: (data) =>
      callbacks.onOutput?.(data.line, data.stream as "stdout" | "stderr"),
    onEnd: (data) => {
      const errorType = (data.error_type as GitErrorType) || "none";
      callbacks.onComplete?.(data.success, errorType);
    },
    onError: (error, data) => {
      const errorType = (data?.error_type as GitErrorType) || "unknown";
      callbacks.onError?.(error, errorType);
    },
  });
}

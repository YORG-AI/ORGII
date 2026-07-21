/**
 * Git Diff API
 *
 * File diff, batch diff, and commit diff functions.
 */
import { createLogger } from "@src/hooks/logger";

import { fetchRustApi, gitRepoUrl } from "./client";
import type {
  CommitDiffResult,
  GitBatchFileDiffInput,
  GitBatchFileDiffResult,
  GitDiffNumstatCombinedResult,
  GitDiffNumstatResult,
  GitDiffSummaryResult,
  GitFileContentResult,
  GitFileDiffResult,
} from "./types";

const log = createLogger("GitAPI");

/**
 * Get file content at a specific git ref
 * Uses Rust HTTP server
 */
export const getGitFileContent = async (params: {
  repo_id: string;
  repo_path?: string;
  file_path: string;
  ref?: string;
}): Promise<GitFileContentResult | undefined> => {
  const queryParams = new URLSearchParams();
  // Always pass the path query param to help backend locate the repo
  queryParams.append("path", params.repo_path || params.repo_id);
  queryParams.append("file_path", params.file_path);
  queryParams.append("ref", params.ref ?? "HEAD");

  const url = `${gitRepoUrl(params.repo_id)}/file/content?${queryParams.toString()}`;

  try {
    const response = await fetchRustApi<GitFileContentResult>(url);
    return response.data;
  } catch (_error) {
    return undefined;
  }
};

/**
 * Get file diff between two refs
 * Uses Rust HTTP server with git2 for structured diff parsing
 */
export const getGitFileDiff = async (params: {
  repo_id: string;
  file_path: string;
  from_ref?: string;
  to_ref?: string;
  context_lines?: number;
}): Promise<GitFileDiffResult | undefined> => {
  const queryParams = new URLSearchParams();
  queryParams.append("file_path", params.file_path);
  queryParams.append("from_ref", params.from_ref ?? "HEAD");
  if (params.to_ref !== undefined) queryParams.append("to_ref", params.to_ref);
  if (params.context_lines !== undefined)
    queryParams.append("context_lines", String(params.context_lines));

  try {
    const response = await fetchRustApi<GitFileDiffResult>(
      `${gitRepoUrl(params.repo_id)}/file/diff?${queryParams.toString()}`
    );
    return response.data;
  } catch (error) {
    log.error("[GitAPI] Failed to get file diff:", error);
    return undefined;
  }
};

/**
 * Get batch file diffs for multiple files
 * Uses Rust HTTP server with git2 for structured diff parsing
 *
 * @param params.files - Array of file inputs. Each can be a string (path) or
 *                       GitBatchFileDiffInput object with path and optional original_path
 *                       for renamed files
 */
export const getGitBatchFileDiffs = async (params: {
  repo_id: string;
  repo_path?: string; // Optional: pass path to avoid UUID lookup
  /** @deprecated Use `files` instead for renamed file support */
  file_paths?: string[];
  /** Array of files - supports renamed files with original_path */
  files?: (string | GitBatchFileDiffInput)[];
  from_ref?: string;
  to_ref?: string;
  context_lines?: number;
}): Promise<GitBatchFileDiffResult | undefined> => {
  try {
    // Build URL with optional path query param
    const queryParams = new URLSearchParams();
    if (params.repo_path) {
      queryParams.append("path", params.repo_path);
    }
    const queryString = queryParams.toString();
    const url = `${gitRepoUrl(params.repo_id)}/files/diff${queryString ? `?${queryString}` : ""}`;

    // Normalize files input: support both legacy file_paths and new files array
    const filesInput = params.files ?? params.file_paths ?? [];
    const normalizedFiles: GitBatchFileDiffInput[] = filesInput.map((file) =>
      typeof file === "string" ? { path: file } : file
    );

    // Extract file_paths for API (always send paths)
    const filePaths = normalizedFiles.map((file) => file.path);

    // Build original_paths map for renamed files
    const originalPaths: Record<string, string> = {};
    normalizedFiles.forEach((file) => {
      if (file.original_path) {
        originalPaths[file.path] = file.original_path;
      }
    });

    const response = await fetchRustApi<GitBatchFileDiffResult>(url, {
      method: "POST",
      body: JSON.stringify({
        file_paths: filePaths,
        original_paths:
          Object.keys(originalPaths).length > 0 ? originalPaths : undefined,
        from_ref: params.from_ref ?? "HEAD",
        to_ref: params.to_ref ?? null,
        context_lines: params.context_lines ?? 3,
      }),
    });
    return response.data;
  } catch (error) {
    log.error("[GitAPI] Failed to get batch file diffs:", error);
    return undefined;
  }
};

/**
 * Get diff summary (overview of changed files)
 * Uses Rust HTTP server
 */
export const getGitDiffSummary = async (params: {
  repo_id: string;
  from_ref?: string;
  to_ref?: string;
}): Promise<GitDiffSummaryResult | undefined> => {
  const queryParams = new URLSearchParams();
  queryParams.append("from_ref", params.from_ref ?? "HEAD");
  if (params.to_ref !== undefined) queryParams.append("to_ref", params.to_ref);

  try {
    const response = await fetchRustApi<GitDiffSummaryResult>(
      `${gitRepoUrl(params.repo_id)}/diff/summary?${queryParams.toString()}`
    );
    return response.data;
  } catch (error) {
    log.error("[GitAPI] Failed to get diff summary:", error);
    return undefined;
  }
};

/**
 * Get staged changes summary
 * Uses Rust HTTP server with git2
 */
export const getGitStagedDiff = async (params: {
  repo_id: string;
  context_lines?: number;
}): Promise<GitBatchFileDiffResult | undefined> => {
  const queryParams = new URLSearchParams();
  if (params.context_lines !== undefined)
    queryParams.append("context_lines", String(params.context_lines));

  try {
    const response = await fetchRustApi<GitBatchFileDiffResult>(
      `${gitRepoUrl(params.repo_id)}/diff/staged${queryParams.toString() ? `?${queryParams.toString()}` : ""}`
    );
    return response.data;
  } catch (error) {
    log.error("[GitAPI] Failed to get staged diff:", error);
    return undefined;
  }
};

/**
 * Get staged file diff
 * Uses Rust HTTP server - calls file diff with HEAD to STAGED comparison
 */
export const getGitStagedFileDiff = async (params: {
  repo_id: string;
  file_path: string;
  context_lines?: number;
}): Promise<GitFileDiffResult | undefined> => {
  // Use the file diff endpoint with HEAD to STAGED comparison
  return getGitFileDiff({
    repo_id: params.repo_id,
    file_path: params.file_path,
    from_ref: "HEAD",
    to_ref: "STAGED",
    context_lines: params.context_lines,
  });
};

/**
 * Get per-file diff numstat (insertions/deletions without content)
 * Lightweight alternative to batch diffs for displaying change counts
 */
export const getGitDiffNumstat = async (params: {
  repo_id: string;
  repo_path?: string;
  from_ref?: string;
  to_ref?: string;
  staged_only?: boolean;
}): Promise<GitDiffNumstatResult | undefined> => {
  const queryParams = new URLSearchParams();
  if (params.repo_path) queryParams.append("path", params.repo_path);
  queryParams.append("from_ref", params.from_ref ?? "HEAD");
  if (params.to_ref !== undefined) queryParams.append("to_ref", params.to_ref);
  if (params.staged_only) queryParams.append("staged_only", "true");

  try {
    const response = await fetchRustApi<GitDiffNumstatResult>(
      `${gitRepoUrl(params.repo_id)}/diff/numstat?${queryParams.toString()}`
    );
    return response.data;
  } catch (error) {
    log.error("[GitAPI] Failed to get diff numstat:", error);
    return undefined;
  }
};

/**
 * Get combined per-file diff numstat for both staged and unstaged changes.
 *
 * Performance optimization: single IPC call instead of 2 separate calls
 * for staged and unstaged numstats. Results are merged in Rust.
 */
export const getGitDiffNumstatCombined = async (params: {
  repo_id: string;
  repo_path?: string;
  from_ref?: string;
  /** Count untracked (new) files toward the totals. Defaults to false. */
  include_untracked?: boolean;
}): Promise<GitDiffNumstatCombinedResult | undefined> => {
  const queryParams = new URLSearchParams();
  if (params.repo_path) queryParams.append("path", params.repo_path);
  queryParams.append("from_ref", params.from_ref ?? "HEAD");
  if (params.include_untracked) queryParams.append("include_untracked", "true");

  try {
    const response = await fetchRustApi<GitDiffNumstatCombinedResult>(
      `${gitRepoUrl(params.repo_id)}/diff/numstat-combined?${queryParams.toString()}`
    );
    return response.data;
  } catch (error) {
    log.error("[GitAPI] Failed to get combined diff numstat:", error);
    return undefined;
  }
};

/**
 * Get commit diff
 * Uses Rust HTTP server with git2
 */
export const getGitCommitDiff = async (params: {
  repo_id: string;
  repo_path?: string;
  commit_sha: string;
  context_lines?: number;
  parent_index?: number;
}): Promise<CommitDiffResult | undefined> => {
  const queryParams = new URLSearchParams();

  // Pass repo path to help backend resolve the repository
  const pathForQuery = params.repo_path || params.repo_id;
  if (pathForQuery) {
    queryParams.append("path", pathForQuery);
  }

  if (params.context_lines !== undefined)
    queryParams.append("context_lines", String(params.context_lines));
  if (params.parent_index !== undefined)
    queryParams.append("parent_index", String(params.parent_index));

  const queryString = queryParams.toString();

  try {
    const response = await fetchRustApi<CommitDiffResult>(
      `${gitRepoUrl(params.repo_id)}/commits/${encodeURIComponent(params.commit_sha)}/diff${queryString ? `?${queryString}` : ""}`
    );
    return response.data;
  } catch (error) {
    log.error("[GitAPI] Failed to get commit diff:", error);
    return undefined;
  }
};

/**
 * Fetch per-file insertion/deletion counts and return them as a lookup map.
 *
 * Wraps `getGitDiffNumstatCombined` and absorbs the raw API shape into a
 * plain `Map<path, { additions, deletions }>` that callers can use directly.
 * Silently returns an empty map when the repo has no commits yet (unborn HEAD)
 * or when the API call fails — numstat is cosmetic and should never block the
 * primary file list.
 *
 * @param repoId   - Repository identifier
 * @param repoPath - Filesystem path to the repository
 * @param fromRef  - Base ref for the diff (defaults to "HEAD")
 */
export async function fetchNumstatMap(
  repoId: string,
  repoPath: string,
  fromRef = "HEAD"
): Promise<Map<string, { additions: number; deletions: number }>> {
  const map = new Map<string, { additions: number; deletions: number }>();
  try {
    const result = await getGitDiffNumstatCombined({
      repo_id: repoId,
      repo_path: repoPath,
      from_ref: fromRef,
      include_untracked: true,
    });
    for (const entry of result?.files ?? []) {
      map.set(entry.path, {
        additions: entry.insertions ?? 0,
        deletions: entry.deletions ?? 0,
      });
    }
  } catch {
    // Non-critical — numstat is cosmetic, unborn repos have no HEAD
  }
  return map;
}

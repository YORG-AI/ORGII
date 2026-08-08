import { getGitCommitDiff, getGitFileContent } from "@src/api/http/git/diff";
import type { CommitDiffResult } from "@src/api/http/git/types";
import { BoundedMap } from "@src/util/collections/BoundedMap";

import {
  ScopedResourceCache,
  type ScopedResourceCacheStats,
} from "./scopedResourceCache";

const COMMIT_CACHE_MAX_ENTRIES = 8;
const COMMIT_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const COMMIT_CACHE_MAX_ENTRY_BYTES = 1024 * 1024;
const FILE_CACHE_MAX_ENTRIES = 8;
const FILE_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const FILE_CACHE_MAX_ENTRY_BYTES = 4 * 1024 * 1024;

export interface CommitDetailRequest {
  commitSha: string;
  repoId: string;
  repoPath: string;
}

export interface CommitFileDiffRequest extends CommitDetailRequest {
  filePath: string;
  fileStatus: string;
  parentSha: string | null;
}

export interface CommitFileDiffSnapshot {
  isBinary: boolean;
  newContent: string;
  oldContent: string;
}

function commitKey(request: CommitDetailRequest): string {
  return JSON.stringify([request.repoId, request.repoPath, request.commitSha]);
}

function fileKey(request: CommitFileDiffRequest): string {
  return JSON.stringify([
    request.repoId,
    request.repoPath,
    request.commitSha,
    request.parentSha,
    request.fileStatus,
    request.filePath,
  ]);
}

function estimateCommitBytes(value: CommitDiffResult | null): number {
  if (!value) return 8;
  try {
    return JSON.stringify(value).length * 2 + 256;
  } catch {
    return COMMIT_CACHE_MAX_ENTRY_BYTES + 1;
  }
}

function estimateFileBytes(value: CommitFileDiffSnapshot): number {
  return (value.oldContent.length + value.newContent.length) * 2 + 256;
}

const commitCache = new ScopedResourceCache<CommitDiffResult | null>({
  estimateSize: estimateCommitBytes,
  maxBytes: COMMIT_CACHE_MAX_BYTES,
  maxEntries: COMMIT_CACHE_MAX_ENTRIES,
  maxEntryBytes: COMMIT_CACHE_MAX_ENTRY_BYTES,
});

const fileCache = new ScopedResourceCache<CommitFileDiffSnapshot>({
  estimateSize: estimateFileBytes,
  maxBytes: FILE_CACHE_MAX_BYTES,
  maxEntries: FILE_CACHE_MAX_ENTRIES,
  maxEntryBytes: FILE_CACHE_MAX_ENTRY_BYTES,
});

const selectedFileByCommit = new BoundedMap<string, string>({
  maxSize: COMMIT_CACHE_MAX_ENTRIES,
  name: "GitCommitSelectedFile",
});

export function getCommitDetailScopeKey(request: CommitDetailRequest): string {
  return commitKey(request);
}

export function getCachedCommitDiff(
  request: CommitDetailRequest
): CommitDiffResult | null {
  return commitCache.get(commitKey(request))?.value ?? null;
}

export function loadCommitDiff(
  request: CommitDetailRequest,
  options: { force?: boolean } = {}
): Promise<CommitDiffResult | null> {
  return commitCache.load(
    commitKey(request),
    () =>
      getGitCommitDiff({
        repo_id: request.repoId,
        repo_path: request.repoPath,
        commit_sha: request.commitSha,
      }).then((result) => result ?? null),
    {
      ...options,
      shouldCache: (value) => value !== null,
    }
  );
}

export function getCachedCommitSelection(
  request: CommitDetailRequest
): string | null {
  return selectedFileByCommit.get(commitKey(request)) ?? null;
}

export function setCachedCommitSelection(
  request: CommitDetailRequest,
  filePath: string | null
): void {
  const key = commitKey(request);
  if (filePath) {
    selectedFileByCommit.set(key, filePath);
  } else {
    selectedFileByCommit.delete(key);
  }
}

export function getCommitFileDiffScopeKey(
  request: CommitFileDiffRequest
): string {
  return fileKey(request);
}

export function getCachedCommitFileDiff(
  request: CommitFileDiffRequest
): CommitFileDiffSnapshot | null {
  return fileCache.get(fileKey(request))?.value ?? null;
}

export function loadCommitFileDiff(
  request: CommitFileDiffRequest,
  options: { force?: boolean } = {}
): Promise<CommitFileDiffSnapshot> {
  return fileCache.load(
    fileKey(request),
    async () => {
      const [oldResult, newResult] = await Promise.all([
        request.fileStatus === "added" || !request.parentSha
          ? Promise.resolve(undefined)
          : getGitFileContent({
              repo_id: request.repoId,
              repo_path: request.repoPath,
              file_path: request.filePath,
              ref: request.parentSha,
            }),
        request.fileStatus === "deleted"
          ? Promise.resolve(undefined)
          : getGitFileContent({
              repo_id: request.repoId,
              repo_path: request.repoPath,
              file_path: request.filePath,
              ref: request.commitSha,
            }),
      ]);

      const expectedOld =
        request.fileStatus !== "added" && Boolean(request.parentSha);
      const expectedNew = request.fileStatus !== "deleted";
      const oldFailed = expectedOld && !oldResult;
      const newFailed = expectedNew && !newResult;
      if (oldFailed || newFailed) {
        throw new Error(
          `Failed to load content for ${request.filePath} (old_ref=${request.parentSha ?? "none"}, new_ref=${request.commitSha}, old_failed=${String(oldFailed)}, new_failed=${String(newFailed)})`
        );
      }

      return {
        isBinary:
          oldResult?.encoding === "base64" || newResult?.encoding === "base64",
        oldContent: oldResult?.content ?? "",
        newContent: newResult?.content ?? "",
      };
    },
    options
  );
}

export function getGitCommitDetailResourceStats(): {
  commits: ScopedResourceCacheStats;
  files: ScopedResourceCacheStats;
  selections: number;
} {
  return {
    commits: commitCache.getStats(),
    files: fileCache.getStats(),
    selections: selectedFileByCommit.size,
  };
}

export function resetGitCommitDetailResourceForTests(): void {
  commitCache.clear();
  fileCache.clear();
  selectedFileByCommit.clear();
}

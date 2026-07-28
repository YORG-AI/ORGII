import { getGitBatchFileDiffs } from "@src/api/http/git/diff";
import type { GitFile } from "@src/types/git/types";
import { decodeOctalPath } from "@src/util/file/pathUtils";
import { diffBaseRefForFile } from "@src/util/git/diffBaseRef";

const BINARY_DIFF_SENTINEL = "Binary file - content not displayed";
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 4;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 30_000;

export interface WorkingTreeDiffContent {
  oldContent: string;
  newContent: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface WorkingTreeDiffRequest {
  repoId?: string;
  repoPath: string;
  file: Pick<
    GitFile,
    "path" | "original_path" | "status" | "staged" | "repoRoot"
  >;
}

interface CacheEntry {
  value: WorkingTreeDiffContent;
  byteSize: number;
  cachedAt: number;
}

const contentCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<WorkingTreeDiffContent | null>>();
let cachedBytes = 0;

function getEffectiveRepoPath(request: WorkingTreeDiffRequest): string {
  return request.file.repoRoot ?? request.repoPath;
}

function getRelativePath(filePath: string, repoPath: string): string {
  return filePath.startsWith(`${repoPath}/`)
    ? filePath.slice(repoPath.length + 1)
    : filePath;
}

function requestKey(request: WorkingTreeDiffRequest): string {
  const repoPath = getEffectiveRepoPath(request);
  return JSON.stringify([
    request.repoId ?? repoPath,
    repoPath,
    diffBaseRefForFile(request.file),
    getRelativePath(request.file.path, repoPath),
    request.file.original_path ?? "",
  ]);
}

function estimateByteSize(value: WorkingTreeDiffContent): number {
  // JavaScript strings are commonly retained as UTF-16. The small fixed
  // allowance covers the cache entry and numeric fields.
  return (value.oldContent.length + value.newContent.length) * 2 + 128;
}

function deleteCacheEntry(key: string): void {
  const entry = contentCache.get(key);
  if (!entry) return;
  cachedBytes -= entry.byteSize;
  contentCache.delete(key);
}

function readCache(key: string): WorkingTreeDiffContent | null {
  const entry = contentCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt >= CACHE_TTL_MS) {
    deleteCacheEntry(key);
    return null;
  }
  contentCache.delete(key);
  contentCache.set(key, entry);
  return entry.value;
}

function writeCache(key: string, value: WorkingTreeDiffContent): void {
  const byteSize = estimateByteSize(value);
  if (byteSize > MAX_ENTRY_BYTES) return;

  deleteCacheEntry(key);
  while (
    contentCache.size >= MAX_CACHE_ENTRIES ||
    cachedBytes + byteSize > MAX_CACHE_BYTES
  ) {
    const oldestKey = contentCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    deleteCacheEntry(oldestKey);
  }

  contentCache.set(key, { value, byteSize, cachedAt: Date.now() });
  cachedBytes += byteSize;
}

function findRequestedDiff(
  request: WorkingTreeDiffRequest,
  files: Awaited<ReturnType<typeof getGitBatchFileDiffs>>
) {
  const repoPath = getEffectiveRepoPath(request);
  const relativePath = getRelativePath(request.file.path, repoPath);
  return files?.files.find((diff) => {
    const decodedPath = decodeOctalPath(diff.file_path);
    return (
      diff.file_path === relativePath ||
      decodedPath === relativePath ||
      getRelativePath(decodedPath, repoPath) === relativePath
    );
  });
}

/**
 * Load one working-tree diff. Concurrent consumers share the same promise,
 * while settled results are retained only in a small byte-bounded LRU.
 */
export function loadWorkingTreeDiff(
  request: WorkingTreeDiffRequest
): Promise<WorkingTreeDiffContent | null> {
  const key = requestKey(request);
  const cached = readCache(key);
  if (cached) return Promise.resolve(cached);

  const existing = inFlight.get(key);
  if (existing) return existing;

  const repoPath = getEffectiveRepoPath(request);
  const relativePath = getRelativePath(request.file.path, repoPath);
  const promise = getGitBatchFileDiffs({
    repo_id: request.repoId ?? repoPath,
    repo_path: repoPath,
    files: [
      {
        path: relativePath,
        original_path: request.file.original_path ?? undefined,
      },
    ],
    from_ref: diffBaseRefForFile(request.file),
    context_lines: 3,
  })
    .then((response) => {
      const diff = findRequestedDiff(request, response);
      if (!diff) return null;
      const value: WorkingTreeDiffContent = diff.binary
        ? {
            oldContent: BINARY_DIFF_SENTINEL,
            newContent: BINARY_DIFF_SENTINEL,
            additions: 0,
            deletions: 0,
            binary: true,
          }
        : {
            oldContent: diff.old_content ?? "",
            newContent: diff.new_content ?? "",
            additions: diff.insertions ?? 0,
            deletions: diff.deletions ?? 0,
            binary: false,
          };
      writeCache(key, value);
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

/** Remove a settled body when its rendered diff is collapsed or discarded. */
export function releaseWorkingTreeDiff(request: WorkingTreeDiffRequest): void {
  deleteCacheEntry(requestKey(request));
}

export function resetWorkingTreeDiffResourceForTests(): void {
  contentCache.clear();
  inFlight.clear();
  cachedBytes = 0;
}

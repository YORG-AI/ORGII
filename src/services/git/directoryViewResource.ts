import { readDir } from "@tauri-apps/plugin-fs";

import { getGitCommits } from "@src/api/http/git";
import { toFsPluginPath } from "@src/util/file/pathUtils";

import {
  ScopedResourceCache,
  type ScopedResourceCacheStats,
} from "./scopedResourceCache";

const DIRECTORY_CACHE_MAX_ENTRIES = 10;
const DIRECTORY_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const DIRECTORY_CACHE_MAX_ENTRY_BYTES = 512 * 1024;
const DIRECTORY_CACHE_MAX_AGE_MS = 5_000;
const DIRECTORY_META_CACHE_MAX_AGE_MS = 30_000;
const DIRECTORY_META_CONCURRENCY = 6;
export const DIRECTORY_META_MAX_ENTRIES = 80;

export interface DirectoryViewRequest {
  directoryPath: string;
  repoPath: string;
}

export interface DirectoryEntryRow {
  name: string;
  path: string;
  type: "directory" | "file";
}

export interface DirectoryEntryGitMeta {
  authorDate: string;
  summary: string;
}

function directoryKey(request: DirectoryViewRequest): string {
  return JSON.stringify([request.repoPath, request.directoryPath]);
}

function entrySignature(entries: DirectoryEntryRow[]): string {
  let hash = 5381;
  for (const entry of entries) {
    const value = `${entry.type}:${entry.path}\0`;
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash * 33) ^ value.charCodeAt(index);
    }
  }
  return `${entries.length}:${hash >>> 0}`;
}

function metadataKey(
  request: DirectoryViewRequest,
  entries: DirectoryEntryRow[]
): string {
  return `${directoryKey(request)}:${entrySignature(entries)}`;
}

function estimateEntriesBytes(entries: DirectoryEntryRow[]): number {
  return entries.reduce(
    (total, entry) => total + (entry.name.length + entry.path.length) * 2 + 64,
    64
  );
}

function estimateMetadataBytes(
  metadata: Map<string, DirectoryEntryGitMeta>
): number {
  let bytes = 64;
  for (const [path, value] of metadata) {
    bytes +=
      (path.length + value.summary.length + value.authorDate.length) * 2 + 64;
  }
  return bytes;
}

const entriesCache = new ScopedResourceCache<DirectoryEntryRow[]>({
  estimateSize: estimateEntriesBytes,
  maxAgeMs: DIRECTORY_CACHE_MAX_AGE_MS,
  maxBytes: DIRECTORY_CACHE_MAX_BYTES,
  maxEntries: DIRECTORY_CACHE_MAX_ENTRIES,
  maxEntryBytes: DIRECTORY_CACHE_MAX_ENTRY_BYTES,
});

const metadataCache = new ScopedResourceCache<
  Map<string, DirectoryEntryGitMeta>
>({
  estimateSize: estimateMetadataBytes,
  maxAgeMs: DIRECTORY_META_CACHE_MAX_AGE_MS,
  maxBytes: DIRECTORY_CACHE_MAX_BYTES,
  maxEntries: DIRECTORY_CACHE_MAX_ENTRIES,
  maxEntryBytes: DIRECTORY_CACHE_MAX_ENTRY_BYTES,
});

function toRelativePath(path: string, repoPath: string): string {
  if (!repoPath || !path.startsWith(repoPath)) return path;
  return path.slice(repoPath.length).replace(/^\//, "") || ".";
}

export function getCachedDirectoryEntries(
  request: DirectoryViewRequest
): DirectoryEntryRow[] | null {
  return entriesCache.get(directoryKey(request))?.value ?? null;
}

export function loadDirectoryEntries(
  request: DirectoryViewRequest,
  options: { force?: boolean } = {}
): Promise<DirectoryEntryRow[]> {
  return entriesCache.load(
    directoryKey(request),
    async () => {
      const dir = toFsPluginPath(request.directoryPath).replace(/\/+$/, "");
      const entries = await readDir(dir);
      return entries
        .map((entry) => ({
          name: entry.name,
          path: `${dir}/${entry.name}`,
          type: entry.isDirectory ? ("directory" as const) : ("file" as const),
        }))
        .sort((left, right) => {
          if (left.type !== right.type) {
            return left.type === "directory" ? -1 : 1;
          }
          return left.name.localeCompare(right.name);
        });
    },
    options
  );
}

export function getCachedDirectoryMetadata(
  request: DirectoryViewRequest,
  entries: DirectoryEntryRow[]
): Map<string, DirectoryEntryGitMeta> | null {
  return metadataCache.get(metadataKey(request, entries))?.value ?? null;
}

async function loadEntryMetadata(
  entry: DirectoryEntryRow,
  repoPath: string
): Promise<DirectoryEntryGitMeta | null> {
  const result = await getGitCommits({
    repo_id: repoPath,
    repo_path: repoPath,
    file_path: toRelativePath(entry.path, repoPath),
    limit: 1,
  });
  const commit = result?.commits[0];
  return commit
    ? {
        summary: commit.summary,
        authorDate: commit.author.date,
      }
    : null;
}

export function loadDirectoryMetadata(
  request: DirectoryViewRequest,
  entries: DirectoryEntryRow[],
  options: { force?: boolean } = {}
): Promise<Map<string, DirectoryEntryGitMeta>> {
  const limitedEntries = entries.slice(0, DIRECTORY_META_MAX_ENTRIES);
  return metadataCache.load(
    metadataKey(request, entries),
    async () => {
      const metadata = new Map<string, DirectoryEntryGitMeta>();
      let nextIndex = 0;
      const workerCount = Math.min(
        DIRECTORY_META_CONCURRENCY,
        limitedEntries.length
      );

      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (nextIndex < limitedEntries.length) {
            const entryIndex = nextIndex;
            nextIndex += 1;
            const entry = limitedEntries[entryIndex];
            try {
              const value = await loadEntryMetadata(entry, request.repoPath);
              if (value) metadata.set(entry.path, value);
            } catch {
              // Git metadata is supplemental; one failed row must not block
              // the directory listing or the remaining metadata workers.
            }
          }
        })
      );

      return metadata;
    },
    options
  );
}

export function getDirectoryViewResourceStats(): {
  entries: ScopedResourceCacheStats;
  metadata: ScopedResourceCacheStats;
} {
  return {
    entries: entriesCache.getStats(),
    metadata: metadataCache.getStats(),
  };
}

export function resetDirectoryViewResourceForTests(): void {
  entriesCache.clear();
  metadataCache.clear();
}

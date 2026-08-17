import { createLogger } from "@src/hooks/logger";
import type { EditOperation } from "@src/types/editor/document";

import {
  MAX_LOADED_FILES_SIZE,
  MAX_METADATA_CACHE_SIZE,
  MAX_UNSAVED_CONTENT_CACHE_SIZE,
} from "./constants";
import type { UnsavedContentCache } from "./types";

const log = createLogger("FileContent");

interface FileMetadataCache {
  isBinary: boolean;
  mtime: number | null;
}

const metadataCache = new Map<string, FileMetadataCache>();
const loadedFilesThisSession = new Set<string>();
const unsavedContentCache = new Map<string, UnsavedContentCache>();

type FileChangeCallback = (filePath: string) => void;
const fileChangeCallbacks = new Set<FileChangeCallback>();

function evictMetadataCache(): void {
  if (metadataCache.size > MAX_METADATA_CACHE_SIZE) {
    const removeCount = metadataCache.size - MAX_METADATA_CACHE_SIZE;
    const keys = [...metadataCache.keys()];
    for (let idx = 0; idx < removeCount; idx++) {
      metadataCache.delete(keys[idx]);
    }
  }

  if (loadedFilesThisSession.size > MAX_LOADED_FILES_SIZE) {
    const removeCount = loadedFilesThisSession.size - MAX_LOADED_FILES_SIZE;
    const loadedKeys = [...loadedFilesThisSession];
    for (let idx = 0; idx < removeCount; idx++) {
      loadedFilesThisSession.delete(loadedKeys[idx]);
    }
  }
}

/**
 * Evict clean (non-dirty) entries, oldest first, until the cache is back
 * under `MAX_UNSAVED_CONTENT_CACHE_SIZE`. Dirty entries are never evicted:
 * they are the only copy of the user's unsaved edits.
 */
function evictUnsavedContentCache(): void {
  if (unsavedContentCache.size <= MAX_UNSAVED_CONTENT_CACHE_SIZE) return;
  let excess = unsavedContentCache.size - MAX_UNSAVED_CONTENT_CACHE_SIZE;
  for (const [key, entry] of unsavedContentCache) {
    if (excess <= 0) break;
    if (entry.dirty) continue;
    unsavedContentCache.delete(key);
    excess -= 1;
  }
}

export function cacheUnsavedContent(
  filePath: string,
  content: string,
  originalContent: string,
  version: number,
  diskVersion: number,
  recentEdits: EditOperation[]
): void {
  if (version !== diskVersion) {
    // Re-insert so Map iteration order doubles as LRU order for eviction.
    unsavedContentCache.delete(filePath);
    // `originalContent` is intentionally not retained: `useFileContent`
    // re-baselines against fresh disk content on restore, so keeping a
    // second full copy of the file text per entry only doubles the cost.
    unsavedContentCache.set(filePath, {
      content,
      version,
      diskVersion,
      recentEdits,
      dirty: content !== originalContent,
    });
    evictUnsavedContentCache();
  }
}

export function popUnsavedContent(
  filePath: string
): UnsavedContentCache | null {
  const cached = unsavedContentCache.get(filePath);
  if (!cached) {
    return null;
  }
  unsavedContentCache.delete(filePath);
  return cached;
}

export function clearUnsavedContentCache(filePath: string): void {
  unsavedContentCache.delete(filePath);
}

export function subscribeToFileChanges(
  callback: FileChangeCallback
): () => void {
  fileChangeCallbacks.add(callback);
  return () => {
    fileChangeCallbacks.delete(callback);
  };
}

export function onExternalFileChange(filePath: string): void {
  metadataCache.delete(filePath);
  loadedFilesThisSession.delete(filePath);

  for (const callback of fileChangeCallbacks) {
    try {
      callback(filePath);
    } catch (error) {
      log.error("[FileContent] File change callback error:", error);
    }
  }
}

export function getCachedBinaryStatus(filePath: string): boolean | null {
  return metadataCache.get(filePath)?.isBinary ?? null;
}

export function getCachedFileMetadata(
  filePath: string
): FileMetadataCache | null {
  return metadataCache.get(filePath) ?? null;
}

export function hasLoadedFileThisSession(filePath: string): boolean {
  return loadedFilesThisSession.has(filePath);
}

export function markFileLoadedThisSession(filePath: string): void {
  loadedFilesThisSession.add(filePath);
  evictMetadataCache();
}

export function cacheFileMetadata(
  filePath: string,
  isBinary: boolean,
  mtime: number | null
): void {
  metadataCache.set(filePath, { isBinary, mtime });
  evictMetadataCache();
}

export function invalidateFileCache(filePath: string): void {
  metadataCache.delete(filePath);
  loadedFilesThisSession.delete(filePath);
}

export function clearFileCache(): void {
  metadataCache.clear();
  loadedFilesThisSession.clear();
}

/** Test-only: drop every cached unsaved buffer. */
export function _resetUnsavedContentCacheForTests(): void {
  unsavedContentCache.clear();
}

/** Diagnostics hook for the RAM monitor / tests. */
export function getUnsavedContentCacheStats(): {
  entries: number;
  dirtyEntries: number;
  contentChars: number;
} {
  let dirtyEntries = 0;
  let contentChars = 0;
  for (const entry of unsavedContentCache.values()) {
    if (entry.dirty) dirtyEntries += 1;
    contentChars += entry.content.length;
  }
  return { entries: unsavedContentCache.size, dirtyEntries, contentChars };
}

export function updateCachedFileMtime(
  filePath: string,
  mtime: number | null
): void {
  const existing = metadataCache.get(filePath);
  if (existing) {
    existing.mtime = mtime;
    return;
  }

  cacheFileMetadata(filePath, false, mtime);
}

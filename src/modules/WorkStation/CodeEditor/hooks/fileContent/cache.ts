import { appDataDir, join } from "@tauri-apps/api/path";
import {
  exists,
  mkdir,
  readDir,
  readTextFile,
  remove,
  stat,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

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

/**
 * One cached buffer. Dirty entries do not keep their text in memory for
 * long: `spillDraftToDisk` writes it under the app data directory and, once
 * the write has landed, drops `content` and keeps `draftPath` instead. The
 * text is read back on `popUnsavedContent`. While a write is in flight (or
 * if it fails) the text stays here, so nothing is ever lost.
 */
interface UnsavedContentEntry {
  content: string | null;
  draftPath: string | null;
  version: number;
  diskVersion: number;
  recentEdits: EditOperation[];
  dirty: boolean;
  /** Distinguishes this entry from a later one cached for the same path. */
  generation: number;
  pendingWrite: Promise<void> | null;
}

const unsavedContentCache = new Map<string, UnsavedContentEntry>();
let unsavedEntryGeneration = 0;

// ============================================
// Unsaved drafts on disk
// ============================================

/** Subdirectory of the app data dir that holds spilled unsaved buffers. */
export const UNSAVED_DRAFT_DIR_NAME = "unsaved-drafts";

/**
 * Drafts only mean something to the process that wrote them (the index is in
 * memory), so leftovers from earlier runs are garbage. Anything older than
 * this is removed the first time the directory is used; younger files are left
 * alone in case another instance is still writing them.
 */
export const STALE_UNSAVED_DRAFT_MS = 24 * 60 * 60 * 1000;

let draftDirPromise: Promise<string | null> | null = null;
const pendingDraftRemovals = new Set<Promise<void>>();

async function hashDraftKey(filePath: string): Promise<string> {
  const bytes = new TextEncoder().encode(filePath);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function removeStaleDrafts(dir: string): Promise<void> {
  const cutoff = Date.now() - STALE_UNSAVED_DRAFT_MS;
  const entries = await readDir(dir);
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile) return;
      const path = await join(dir, entry.name);
      try {
        const info = await stat(path);
        const modified = info.mtime ? new Date(info.mtime).getTime() : 0;
        if (modified < cutoff) {
          await remove(path);
        }
      } catch {
        // A file that vanished or cannot be inspected is not our problem.
      }
    })
  );
}

/**
 * Resolve (and on first use create and sweep) the draft directory. Resolves
 * to `null` when the app data directory is unavailable, in which case dirty
 * buffers simply stay in memory as before.
 */
function ensureDraftDir(): Promise<string | null> {
  if (!draftDirPromise) {
    draftDirPromise = (async () => {
      try {
        const dir = await join(await appDataDir(), UNSAVED_DRAFT_DIR_NAME);
        if (!(await exists(dir))) {
          await mkdir(dir, { recursive: true });
        } else {
          await removeStaleDrafts(dir);
        }
        return dir;
      } catch (error) {
        log.warn(
          "[FileContent] Unsaved drafts stay in memory: draft dir unavailable",
          error
        );
        return null;
      }
    })();
  }
  return draftDirPromise;
}

function removeDraftFile(draftPath: string): void {
  const removal = remove(draftPath).catch(() => {
    // Already gone, or not removable: either way nothing is retained.
  });
  pendingDraftRemovals.add(removal);
  void removal.finally(() => {
    pendingDraftRemovals.delete(removal);
  });
}

/**
 * Write a dirty entry's text to disk and, if the entry is still the live one
 * for its path when the write lands, release the in-memory copy.
 */
async function spillDraftToDisk(
  filePath: string,
  entry: UnsavedContentEntry
): Promise<void> {
  const dir = await ensureDraftDir();
  const content = entry.content;
  if (dir === null || content === null) return;
  let draftPath: string;
  try {
    draftPath = await join(
      dir,
      `${await hashDraftKey(filePath)}-${entry.generation}.txt`
    );
    await writeTextFile(draftPath, content);
  } catch (error) {
    log.warn("[FileContent] Unsaved draft stays in memory: write failed", {
      filePath,
      error,
    });
    return;
  }
  if (unsavedContentCache.get(filePath) !== entry) {
    // Popped, cleared or replaced while the write was in flight: the file
    // has no owner, and the text was returned from memory.
    removeDraftFile(draftPath);
    return;
  }
  entry.draftPath = draftPath;
  entry.content = null;
}

function toUnsavedContentCache(
  entry: UnsavedContentEntry,
  content: string
): UnsavedContentCache {
  return {
    content,
    version: entry.version,
    diskVersion: entry.diskVersion,
    recentEdits: entry.recentEdits,
    dirty: entry.dirty,
  };
}

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
    const previous = unsavedContentCache.get(filePath);
    unsavedContentCache.delete(filePath);
    if (previous?.draftPath) {
      removeDraftFile(previous.draftPath);
    }
    // `originalContent` is intentionally not retained: `useFileContent`
    // re-baselines against fresh disk content on restore, so keeping a
    // second full copy of the file text per entry only doubles the cost.
    const dirty = content !== originalContent;
    unsavedEntryGeneration += 1;
    const entry: UnsavedContentEntry = {
      content,
      draftPath: null,
      version,
      diskVersion,
      recentEdits,
      dirty,
      generation: unsavedEntryGeneration,
      pendingWrite: null,
    };
    unsavedContentCache.set(filePath, entry);
    evictUnsavedContentCache();
    if (dirty) {
      // Dirty buffers are never evicted, so they are the ones worth moving
      // out of the heap. Clean entries are small in number (capped above)
      // and eviction candidates, so they stay as they are.
      entry.pendingWrite = spillDraftToDisk(filePath, entry).finally(() => {
        entry.pendingWrite = null;
      });
    }
  }
}

/**
 * Take a cached buffer out of the cache. Resolves the text from the on-disk
 * draft when the entry was spilled, so callers always get the full content.
 */
export async function popUnsavedContent(
  filePath: string
): Promise<UnsavedContentCache | null> {
  const cached = unsavedContentCache.get(filePath);
  if (!cached) {
    return null;
  }
  unsavedContentCache.delete(filePath);
  if (cached.content !== null) {
    // A write may still be in flight; `spillDraftToDisk` notices the entry is
    // no longer live when it lands and removes the orphaned file.
    return toUnsavedContentCache(cached, cached.content);
  }
  const draftPath = cached.draftPath;
  if (draftPath === null) {
    return null;
  }
  try {
    const content = await readTextFile(draftPath);
    removeDraftFile(draftPath);
    return toUnsavedContentCache(cached, content);
  } catch (error) {
    log.error("[FileContent] Unsaved draft could not be read back", {
      filePath,
      draftPath,
      error,
    });
    return null;
  }
}

export function clearUnsavedContentCache(filePath: string): void {
  const cached = unsavedContentCache.get(filePath);
  unsavedContentCache.delete(filePath);
  if (cached?.draftPath) {
    removeDraftFile(cached.draftPath);
  }
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

/** Test-only: drop every cached unsaved buffer and forget the draft dir. */
export function _resetUnsavedContentCacheForTests(): void {
  unsavedContentCache.clear();
  draftDirPromise = null;
}

/** Test-only: wait for every in-flight draft write and removal. */
export async function _flushUnsavedDraftIoForTests(): Promise<void> {
  await Promise.all(
    [...unsavedContentCache.values()].map((entry) => entry.pendingWrite)
  );
  await Promise.all([...pendingDraftRemovals]);
}

/** Diagnostics hook for the RAM monitor / tests. */
export function getUnsavedContentCacheStats(): {
  entries: number;
  dirtyEntries: number;
  /** Dirty entries whose text lives on disk rather than in the heap. */
  spilledEntries: number;
  /** Characters still held in memory. */
  contentChars: number;
} {
  let dirtyEntries = 0;
  let spilledEntries = 0;
  let contentChars = 0;
  for (const entry of unsavedContentCache.values()) {
    if (entry.dirty) dirtyEntries += 1;
    if (entry.content === null) {
      spilledEntries += 1;
    } else {
      contentChars += entry.content.length;
    }
  }
  return {
    entries: unsavedContentCache.size,
    dirtyEntries,
    spilledEntries,
    contentChars,
  };
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

import { readTextFile } from "@tauri-apps/plugin-fs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createLogger } from "@src/hooks/logger";
import type { EditOperation, EditSource } from "@src/types/editor/document";
import {
  createEditOperation,
  filterEditsBySource,
} from "@src/types/editor/document";
import {
  getBinaryFileMessage,
  isBinaryByExtension,
  isBinaryContent,
} from "@src/util/file/binaryDetection";
import { toFsPluginPath } from "@src/util/file/pathUtils";

import {
  cacheFileMetadata,
  cacheUnsavedContent,
  clearFileCache,
  clearUnsavedContentCache,
  getCachedBinaryStatus,
  getCachedFileMetadata,
  hasLoadedFileThisSession,
  invalidateFileCache,
  markFileLoadedThisSession,
  onExternalFileChange,
  popUnsavedContent,
  subscribeToFileChanges,
  updateCachedFileMtime,
} from "./cache";
import { MAX_EDIT_LOG_SIZE } from "./constants";
import { classifyFileError } from "./errors";
import { fetchFileMtime } from "./mtime";
import type {
  FileError,
  UseFileContentOptions,
  UseFileContentReturn,
} from "./types";

const log = createLogger("FileContent");

export type { FileError, UseFileContentOptions, UseFileContentReturn };
export {
  clearFileCache,
  clearUnsavedContentCache,
  invalidateFileCache,
  onExternalFileChange,
  subscribeToFileChanges,
  updateCachedFileMtime,
};

export function useFileContent(
  options: UseFileContentOptions
): UseFileContentReturn {
  const { filePath, autoLoad = true } = options;

  const [content, setContent] = useState<string>("");
  const [originalContent, setOriginalContent] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<FileError | null>(null);
  const [isBinary, setIsBinary] = useState<boolean>(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState<boolean>(false);
  // Track which file path the current content was loaded for
  // This allows detecting mismatches during render (not just in effects)
  const [loadedFilePath, setLoadedFilePath] = useState<string | null>(null);

  // Versioning (VSCode-style)
  const [version, setVersion] = useState<number>(0);
  const [diskVersion, setDiskVersion] = useState<number>(0);
  const [recentEdits, setRecentEdits] = useState<EditOperation[]>([]);
  const [diskMtime, setDiskMtime] = useState<number | null>(null);

  // Track current file path to avoid stale updates
  const currentFilePathRef = useRef<string | null>(null);
  const loadingRef = useRef<boolean>(false);

  // Use ref to access version in loadContent without adding it as a dependency
  // This prevents loadContent from being recreated on every version change
  const versionRef = useRef(version);

  // Refs for caching unsaved content when switching files
  const contentRef = useRef(content);
  const originalContentRef = useRef(originalContent);
  const diskVersionRef = useRef(diskVersion);
  const recentEditsRef = useRef(recentEdits);

  useEffect(() => {
    versionRef.current = version;
  }, [version]);

  useEffect(() => {
    contentRef.current = content;
    originalContentRef.current = originalContent;
    diskVersionRef.current = diskVersion;
    recentEditsRef.current = recentEdits;
  }, [content, originalContent, diskVersion, recentEdits]);

  // Cache unsaved content before switching to a new file
  useEffect(() => {
    const prevFilePath = currentFilePathRef.current;
    // When filePath changes and we had a previous file with unsaved changes
    if (prevFilePath && prevFilePath !== filePath) {
      cacheUnsavedContent(
        prevFilePath,
        contentRef.current,
        originalContentRef.current,
        versionRef.current,
        diskVersionRef.current,
        recentEditsRef.current
      );
    }
  }, [filePath]);

  // Derive readiness from the loaded path. When autoLoad is disabled, this hook
  // intentionally exposes a neutral unloaded state until callers explicitly reload.
  const hasLoadedCurrentFile = loadedFilePath === filePath;
  const contentReady = !filePath ? true : hasLoadedCurrentFile;
  const shouldExposeLoadedState = !filePath || hasLoadedCurrentFile;

  // Load file content
  const loadContent = useCallback(async () => {
    if (!filePath) {
      setContent("");
      setOriginalContent("");
      setError(null);
      setIsBinary(false);
      setHasUnsavedChanges(false);
      setVersion(0);
      setDiskVersion(0);
      setRecentEdits([]);
      setDiskMtime(null);
      return;
    }

    // Prevent duplicate loads
    if (loadingRef.current && currentFilePathRef.current === filePath) {
      return;
    }

    currentFilePathRef.current = filePath;

    loadingRef.current = true;
    setLoading(true);
    setError(null);

    // PERFORMANCE: Check cached binary status first (avoids disk read for known binaries)
    const cachedBinary = getCachedBinaryStatus(filePath);
    if (cachedBinary === true) {
      const message = getBinaryFileMessage();
      setContent(message);
      setOriginalContent(message);
      setIsBinary(true);
      setVersion(0);
      setDiskVersion(0);
      setRecentEdits([]);
      setDiskMtime(null);
      setHasUnsavedChanges(false);
      setLoading(false);
      loadingRef.current = false;
      return;
    }

    try {
      // Check if binary by extension first
      if (isBinaryByExtension(filePath)) {
        const message = getBinaryFileMessage();
        setContent(message);
        setOriginalContent(message);
        setIsBinary(true);
        cacheFileMetadata(filePath, true, null);
        // Reset versioning for binary files
        setVersion(0);
        setDiskVersion(0);
        setRecentEdits([]);
        setDiskMtime(null);
        setHasUnsavedChanges(false);
        return;
      }

      // Read file content from disk
      // Note: OS file cache makes repeated reads fast (~1-5ms for recently accessed files)
      const fileContent = await readTextFile(toFsPluginPath(filePath));

      // Check for stale response
      if (currentFilePathRef.current !== filePath) {
        return;
      }

      // Check if content is binary
      if (isBinaryContent(fileContent)) {
        const message = getBinaryFileMessage();
        setContent(message);
        setOriginalContent(message);
        setIsBinary(true);
        cacheFileMetadata(filePath, true, null);
        // Reset versioning for binary files
        setVersion(0);
        setDiskVersion(0);
        setRecentEdits([]);
        setDiskMtime(null);
        setHasUnsavedChanges(false);
        return;
      }

      // Check for cached unsaved content from a previous tab switch
      const cachedUnsaved = popUnsavedContent(filePath);

      if (cachedUnsaved) {
        // Restore unsaved content from cache
        // Update originalContent to current disk content in case file changed externally
        setOriginalContent(fileContent);
        setContent(cachedUnsaved.content);
        setVersion(cachedUnsaved.version);
        setDiskVersion(cachedUnsaved.diskVersion);
        setRecentEdits(cachedUnsaved.recentEdits);
        setIsBinary(false);
        // Recalculate hasUnsavedChanges based on whether content differs from disk
        setHasUnsavedChanges(cachedUnsaved.content !== fileContent);
      } else {
        // No cached content - use freshly loaded content from disk
        // Increment version on successful load
        // Use ref to get current version to avoid stale closure issues
        const nextVersion = versionRef.current + 1;
        setVersion(nextVersion);

        setContent(fileContent);
        setOriginalContent(fileContent);
        setIsBinary(false);
        setHasUnsavedChanges(false);
        setDiskVersion(nextVersion);

        // Create reload edit operation
        const reloadEdit = createEditOperation(
          { from: 0, to: 0 },
          fileContent,
          { type: "reload" },
          nextVersion
        );
        setRecentEdits([reloadEdit]);
      }

      // PERFORMANCE: Only fetch mtime on first load of this file in session
      // Tab switches reuse the cached mtime, file watcher handles invalidation
      const isFirstLoad = !hasLoadedFileThisSession(filePath);
      if (isFirstLoad) {
        markFileLoadedThisSession(filePath);
        // Fetch disk modification time in background (don't block rendering)
        void fetchFileMtime(filePath)
          .then((mtime) => {
            if (currentFilePathRef.current === filePath) {
              setDiskMtime(mtime);
              cacheFileMetadata(filePath, false, mtime);
            }
          })
          .catch((error: unknown) => {
            log.error("[FileContent] Failed to fetch file mtime:", error);
            if (currentFilePathRef.current === filePath) {
              setDiskMtime(null);
              cacheFileMetadata(filePath, false, null);
            }
          });
      } else {
        // Reuse cached mtime for faster tab switches
        const cachedMeta = getCachedFileMetadata(filePath);
        if (cachedMeta) {
          setDiskMtime(cachedMeta.mtime);
        }
      }

      // Cache metadata (tiny - just binary status)
      cacheFileMetadata(
        filePath,
        false,
        getCachedFileMetadata(filePath)?.mtime ?? null
      );
    } catch (err) {
      // Check for stale response
      if (currentFilePathRef.current !== filePath) {
        return;
      }

      const typedError = classifyFileError(
        err instanceof Error ? err.message : String(err)
      );

      setError(typedError);
      setContent("");
      setOriginalContent("");
      setIsBinary(false);
      // Reset versioning on error
      setVersion(0);
      setDiskVersion(0);
      setRecentEdits([]);
      setDiskMtime(null);
      setHasUnsavedChanges(false);
    } finally {
      if (currentFilePathRef.current === filePath) {
        setLoading(false);
        loadingRef.current = false;
        // Track which file path this content was loaded for
        setLoadedFilePath(filePath);
      }
    }
  }, [filePath]); // Note: version accessed via ref, not as dependency

  // Auto-load on file path change
  useEffect(() => {
    if (autoLoad) {
      loadContent();
    }
  }, [filePath, autoLoad, loadContent]);

  // Subscribe to external file change notifications
  // When file watcher detects this file changed externally, reload it
  useEffect(() => {
    if (!filePath) return;

    const unsubscribe = subscribeToFileChanges((changedPath) => {
      // Check if the changed file matches our current file
      // Handle both exact match and path ending match (for relative vs absolute)
      if (
        changedPath === filePath ||
        filePath.endsWith(`/${changedPath}`) ||
        changedPath.endsWith(`/${filePath.split("/").pop()}`)
      ) {
        loadContent();
      }
    });

    return unsubscribe;
  }, [filePath, loadContent]);

  // Update content with source attribution (for editing)
  const updateContent = useCallback(
    (newContent: string, source: EditSource) => {
      const nextVersion = version + 1;

      // Create edit operation
      const edit = createEditOperation(
        { from: 0, to: content.length }, // Simplified: full replacement
        newContent,
        source,
        nextVersion
      );

      // Update state
      setContent(newContent);
      setVersion(nextVersion);
      setRecentEdits(
        (prev) => [...prev, edit].slice(-MAX_EDIT_LOG_SIZE) // Keep last N edits
      );
      setHasUnsavedChanges(nextVersion !== diskVersion);
    },
    [version, diskVersion, content]
  );

  // Mark as saved
  const markSaved = useCallback(() => {
    setOriginalContent(content);
    setDiskVersion(version); // Update disk version to match current version
    setHasUnsavedChanges(false);
    // Clear unsaved content cache since changes are now saved
    if (filePath) {
      clearUnsavedContentCache(filePath);
    }
  }, [content, version, filePath]);

  // Discard changes
  const discardChanges = useCallback(() => {
    setContent(originalContent);
    setVersion(diskVersion); // Reset version to disk version
    setHasUnsavedChanges(false);
    // Clear unsaved content cache since changes are discarded
    if (filePath) {
      clearUnsavedContentCache(filePath);
    }
  }, [originalContent, diskVersion, filePath]);

  // Helper functions for filtering edits by source type
  const getAIEdits = useCallback(() => {
    return filterEditsBySource(recentEdits, "ai");
  }, [recentEdits]);

  const getHumanEdits = useCallback(() => {
    return filterEditsBySource(recentEdits, "human");
  }, [recentEdits]);

  const getExternalEdits = useCallback(() => {
    return filterEditsBySource(recentEdits, "external");
  }, [recentEdits]);

  const exposedContent = shouldExposeLoadedState ? content : "";
  const exposedOriginalContent = shouldExposeLoadedState ? originalContent : "";
  const exposedLoading = shouldExposeLoadedState ? loading : false;
  const exposedError = shouldExposeLoadedState ? error : null;
  const exposedIsBinary = shouldExposeLoadedState ? isBinary : false;
  const exposedHasUnsavedChanges = shouldExposeLoadedState
    ? hasUnsavedChanges
    : false;

  // Memoize return object to prevent unnecessary re-renders in consumers
  return useMemo(
    () => ({
      content: exposedContent,
      originalContent: exposedOriginalContent,
      loading: exposedLoading,
      error: exposedError,
      isBinary: exposedIsBinary,
      hasUnsavedChanges: exposedHasUnsavedChanges,
      contentReady,
      // Versioning
      version,
      diskVersion,
      diskMtime,
      // Edit attribution
      recentEdits,
      getAIEdits,
      getHumanEdits,
      getExternalEdits,
      // Actions
      reload: loadContent,
      updateContent,
      markSaved,
      discardChanges,
    }),
    [
      exposedContent,
      exposedOriginalContent,
      exposedLoading,
      exposedError,
      exposedIsBinary,
      exposedHasUnsavedChanges,
      contentReady,
      version,
      diskVersion,
      diskMtime,
      recentEdits,
      getAIEdits,
      getHumanEdits,
      getExternalEdits,
      loadContent,
      updateContent,
      markSaved,
      discardChanges,
    ]
  );
}

/**
 * Tests for file content cache (metadata, unsaved content, file changes).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetUnsavedContentCacheForTests,
  cacheFileMetadata,
  cacheUnsavedContent,
  clearFileCache,
  clearUnsavedContentCache,
  getCachedBinaryStatus,
  getCachedFileMetadata,
  getUnsavedContentCacheStats,
  hasLoadedFileThisSession,
  invalidateFileCache,
  markFileLoadedThisSession,
  onExternalFileChange,
  popUnsavedContent,
  subscribeToFileChanges,
  updateCachedFileMtime,
} from "@src/modules/WorkStation/CodeEditor/hooks/fileContent/cache";
import { MAX_UNSAVED_CONTENT_CACHE_SIZE } from "@src/modules/WorkStation/CodeEditor/hooks/fileContent/constants";

describe("fileContent/cache", () => {
  beforeEach(() => {
    // Clear all caches before each test
    clearFileCache();
    _resetUnsavedContentCacheForTests();
  });

  describe("cacheFileMetadata and getCachedFileMetadata", () => {
    it("stores and retrieves file metadata", () => {
      cacheFileMetadata("/path/to/file.ts", false, 1234567890);

      const metadata = getCachedFileMetadata("/path/to/file.ts");
      expect(metadata).toEqual({ isBinary: false, mtime: 1234567890 });
    });

    it("returns null for non-cached file", () => {
      const metadata = getCachedFileMetadata("/uncached/file.ts");
      expect(metadata).toBeNull();
    });

    it("stores binary status", () => {
      cacheFileMetadata("/path/to/image.png", true, null);

      const metadata = getCachedFileMetadata("/path/to/image.png");
      expect(metadata?.isBinary).toBe(true);
    });
  });

  describe("getCachedBinaryStatus", () => {
    it("returns binary status from cache", () => {
      cacheFileMetadata("/file.txt", false, null);
      cacheFileMetadata("/image.png", true, null);

      expect(getCachedBinaryStatus("/file.txt")).toBe(false);
      expect(getCachedBinaryStatus("/image.png")).toBe(true);
    });

    it("returns null for non-cached file", () => {
      expect(getCachedBinaryStatus("/uncached.txt")).toBeNull();
    });
  });

  describe("updateCachedFileMtime", () => {
    it("updates mtime for existing cached file", () => {
      cacheFileMetadata("/file.ts", false, 1000);

      updateCachedFileMtime("/file.ts", 2000);

      const metadata = getCachedFileMetadata("/file.ts");
      expect(metadata?.mtime).toBe(2000);
    });

    it("creates new cache entry if file not cached", () => {
      updateCachedFileMtime("/new-file.ts", 3000);

      const metadata = getCachedFileMetadata("/new-file.ts");
      expect(metadata).toEqual({ isBinary: false, mtime: 3000 });
    });
  });

  describe("hasLoadedFileThisSession and markFileLoadedThisSession", () => {
    it("tracks files loaded in session", () => {
      expect(hasLoadedFileThisSession("/file.ts")).toBe(false);

      markFileLoadedThisSession("/file.ts");

      expect(hasLoadedFileThisSession("/file.ts")).toBe(true);
    });
  });

  describe("invalidateFileCache", () => {
    it("removes file from metadata cache", () => {
      cacheFileMetadata("/file.ts", false, 1000);
      expect(getCachedFileMetadata("/file.ts")).not.toBeNull();

      invalidateFileCache("/file.ts");

      expect(getCachedFileMetadata("/file.ts")).toBeNull();
    });

    it("removes file from loaded files set", () => {
      markFileLoadedThisSession("/file.ts");
      expect(hasLoadedFileThisSession("/file.ts")).toBe(true);

      invalidateFileCache("/file.ts");

      expect(hasLoadedFileThisSession("/file.ts")).toBe(false);
    });
  });

  describe("clearFileCache", () => {
    it("clears all cached metadata", () => {
      cacheFileMetadata("/file1.ts", false, 1000);
      cacheFileMetadata("/file2.ts", true, 2000);
      markFileLoadedThisSession("/file1.ts");

      clearFileCache();

      expect(getCachedFileMetadata("/file1.ts")).toBeNull();
      expect(getCachedFileMetadata("/file2.ts")).toBeNull();
      expect(hasLoadedFileThisSession("/file1.ts")).toBe(false);
    });
  });

  describe("cacheUnsavedContent and popUnsavedContent", () => {
    it("caches unsaved content when version differs from disk", () => {
      cacheUnsavedContent(
        "/file.ts",
        "modified content",
        "original content",
        2, // version
        1, // diskVersion
        []
      );

      const cached = popUnsavedContent("/file.ts");
      expect(cached).not.toBeNull();
      expect(cached?.content).toBe("modified content");
      expect(cached?.dirty).toBe(true);
      expect(cached?.version).toBe(2);
      expect(cached?.diskVersion).toBe(1);
      // The disk baseline is re-read on restore, so it is not retained.
      expect(cached).not.toHaveProperty("originalContent");
    });

    it("marks entries whose buffer equals disk as clean", () => {
      cacheUnsavedContent("/file.ts", "same", "same", 3, 1, []);
      expect(popUnsavedContent("/file.ts")?.dirty).toBe(false);
    });

    it("evicts only clean entries once the soft cap is exceeded", () => {
      for (let i = 0; i < MAX_UNSAVED_CONTENT_CACHE_SIZE; i++) {
        // Even indices dirty, odd indices clean.
        const dirty = i % 2 === 0;
        cacheUnsavedContent(
          `/f${i}.ts`,
          dirty ? `edited-${i}` : "same",
          "same",
          2,
          1,
          []
        );
      }
      expect(getUnsavedContentCacheStats().entries).toBe(
        MAX_UNSAVED_CONTENT_CACHE_SIZE
      );

      // Two more dirty entries push the cache over the cap.
      cacheUnsavedContent("/extra-a.ts", "edited-a", "same", 2, 1, []);
      cacheUnsavedContent("/extra-b.ts", "edited-b", "same", 2, 1, []);

      const stats = getUnsavedContentCacheStats();
      expect(stats.entries).toBe(MAX_UNSAVED_CONTENT_CACHE_SIZE);
      // The oldest *clean* entries were evicted, dirty ones survived.
      expect(popUnsavedContent("/f1.ts")).toBeNull();
      expect(popUnsavedContent("/f3.ts")).toBeNull();
      expect(popUnsavedContent("/f0.ts")).not.toBeNull();
      expect(popUnsavedContent("/f2.ts")).not.toBeNull();
      expect(popUnsavedContent("/extra-a.ts")).not.toBeNull();
      expect(popUnsavedContent("/extra-b.ts")).not.toBeNull();
    });

    it("never evicts dirty entries even past the cap", () => {
      const overCap = MAX_UNSAVED_CONTENT_CACHE_SIZE + 5;
      for (let i = 0; i < overCap; i++) {
        cacheUnsavedContent(`/d${i}.ts`, `edited-${i}`, "same", 2, 1, []);
      }
      const stats = getUnsavedContentCacheStats();
      expect(stats.entries).toBe(overCap);
      expect(stats.dirtyEntries).toBe(overCap);
    });

    it("does not cache when version equals disk version", () => {
      cacheUnsavedContent(
        "/file.ts",
        "same content",
        "same content",
        1, // version
        1, // diskVersion (same)
        []
      );

      const cached = popUnsavedContent("/file.ts");
      expect(cached).toBeNull();
    });

    it("popUnsavedContent removes entry after retrieval", () => {
      cacheUnsavedContent("/file.ts", "content", "original", 2, 1, []);

      // First pop returns the content
      expect(popUnsavedContent("/file.ts")).not.toBeNull();

      // Second pop returns null (already removed)
      expect(popUnsavedContent("/file.ts")).toBeNull();
    });

    it("returns null for non-cached file", () => {
      expect(popUnsavedContent("/uncached.ts")).toBeNull();
    });
  });

  describe("clearUnsavedContentCache", () => {
    it("removes specific file from unsaved content cache", () => {
      cacheUnsavedContent("/file1.ts", "content1", "orig1", 2, 1, []);
      cacheUnsavedContent("/file2.ts", "content2", "orig2", 2, 1, []);

      clearUnsavedContentCache("/file1.ts");

      expect(popUnsavedContent("/file1.ts")).toBeNull();
      expect(popUnsavedContent("/file2.ts")).not.toBeNull();
    });
  });

  describe("subscribeToFileChanges and onExternalFileChange", () => {
    it("notifies subscribers when file changes externally", () => {
      const callback = vi.fn();
      const unsubscribe = subscribeToFileChanges(callback);

      onExternalFileChange("/changed-file.ts");

      expect(callback).toHaveBeenCalledWith("/changed-file.ts");
      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();
    });

    it("unsubscribe removes callback", () => {
      const callback = vi.fn();
      const unsubscribe = subscribeToFileChanges(callback);

      unsubscribe();
      onExternalFileChange("/file.ts");

      expect(callback).not.toHaveBeenCalled();
    });

    it("invalidates cache on external change", () => {
      cacheFileMetadata("/file.ts", false, 1000);
      markFileLoadedThisSession("/file.ts");

      onExternalFileChange("/file.ts");

      expect(getCachedFileMetadata("/file.ts")).toBeNull();
      expect(hasLoadedFileThisSession("/file.ts")).toBe(false);
    });

    it("handles callback errors gracefully", () => {
      const errorCallback = vi.fn(() => {
        throw new Error("Callback error");
      });
      const normalCallback = vi.fn();

      subscribeToFileChanges(errorCallback);
      subscribeToFileChanges(normalCallback);

      // Should not throw, and second callback should still be called
      expect(() => onExternalFileChange("/file.ts")).not.toThrow();
      expect(normalCallback).toHaveBeenCalled();
    });
  });

  describe("cache eviction (FIFO)", () => {
    it("evicts oldest entries when metadata cache exceeds MAX_METADATA_CACHE_SIZE", () => {
      // MAX_METADATA_CACHE_SIZE is 500
      // Add 510 files
      for (let idx = 0; idx < 510; idx++) {
        cacheFileMetadata(`/file-${idx}.ts`, false, idx);
      }

      // First 10 files should be evicted (FIFO)
      for (let idx = 0; idx < 10; idx++) {
        expect(getCachedFileMetadata(`/file-${idx}.ts`)).toBeNull();
      }

      // Later files should still exist
      expect(getCachedFileMetadata("/file-500.ts")).not.toBeNull();
    });

    it("evicts from loadedFilesThisSession when exceeds MAX_LOADED_FILES_SIZE", () => {
      // MAX_LOADED_FILES_SIZE is 1000
      // Add 1010 files
      for (let idx = 0; idx < 1010; idx++) {
        markFileLoadedThisSession(`/file-${idx}.ts`);
      }

      // First 10 files should be evicted
      for (let idx = 0; idx < 10; idx++) {
        expect(hasLoadedFileThisSession(`/file-${idx}.ts`)).toBe(false);
      }

      // Later files should still exist
      expect(hasLoadedFileThisSession("/file-1000.ts")).toBe(true);
    });
  });
});

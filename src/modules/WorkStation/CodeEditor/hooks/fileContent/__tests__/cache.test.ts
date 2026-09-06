/**
 * Tests for file content cache (metadata, unsaved content, file changes).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  STALE_UNSAVED_DRAFT_MS,
  UNSAVED_DRAFT_DIR_NAME,
  _flushUnsavedDraftIoForTests,
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

// In-memory stand-in for the app data directory the draft store writes to.
const fakeFs = vi.hoisted(() => ({
  files: new Map<string, string>(),
  mtimes: new Map<string, number>(),
  dirs: new Set<string>(),
  failWrites: false,
  reset() {
    this.files.clear();
    this.mtimes.clear();
    this.dirs.clear();
    this.failWrites = false;
  },
}));

vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: vi.fn(async () => "/app-data"),
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(
    async (path: string) => fakeFs.dirs.has(path) || fakeFs.files.has(path)
  ),
  mkdir: vi.fn(async (path: string) => {
    fakeFs.dirs.add(path);
  }),
  writeTextFile: vi.fn(async (path: string, content: string) => {
    if (fakeFs.failWrites) throw new Error("disk full");
    fakeFs.files.set(path, content);
    fakeFs.mtimes.set(path, Date.now());
  }),
  readTextFile: vi.fn(async (path: string) => {
    const content = fakeFs.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }),
  remove: vi.fn(async (path: string) => {
    fakeFs.files.delete(path);
    fakeFs.mtimes.delete(path);
  }),
  readDir: vi.fn(async (dir: string) =>
    [...fakeFs.files.keys()]
      .filter((path) => path.startsWith(`${dir}/`))
      .map((path) => ({
        name: path.slice(dir.length + 1),
        isFile: true,
        isDirectory: false,
        isSymlink: false,
      }))
  ),
  stat: vi.fn(async (path: string) => ({
    mtime: new Date(fakeFs.mtimes.get(path) ?? Date.now()),
  })),
}));

const DRAFT_DIR = `/app-data/${UNSAVED_DRAFT_DIR_NAME}`;

describe("fileContent/cache", () => {
  beforeEach(() => {
    // Clear all caches before each test
    clearFileCache();
    _resetUnsavedContentCacheForTests();
    fakeFs.reset();
  });

  describe("cacheFileMetadata and getCachedFileMetadata", () => {
    it("stores and retrieves file metadata", async () => {
      cacheFileMetadata("/path/to/file.ts", false, 1234567890);

      const metadata = getCachedFileMetadata("/path/to/file.ts");
      expect(metadata).toEqual({ isBinary: false, mtime: 1234567890 });
    });

    it("returns null for non-cached file", async () => {
      const metadata = getCachedFileMetadata("/uncached/file.ts");
      expect(metadata).toBeNull();
    });

    it("stores binary status", async () => {
      cacheFileMetadata("/path/to/image.png", true, null);

      const metadata = getCachedFileMetadata("/path/to/image.png");
      expect(metadata?.isBinary).toBe(true);
    });
  });

  describe("getCachedBinaryStatus", () => {
    it("returns binary status from cache", async () => {
      cacheFileMetadata("/file.txt", false, null);
      cacheFileMetadata("/image.png", true, null);

      expect(getCachedBinaryStatus("/file.txt")).toBe(false);
      expect(getCachedBinaryStatus("/image.png")).toBe(true);
    });

    it("returns null for non-cached file", async () => {
      expect(getCachedBinaryStatus("/uncached.txt")).toBeNull();
    });
  });

  describe("updateCachedFileMtime", () => {
    it("updates mtime for existing cached file", async () => {
      cacheFileMetadata("/file.ts", false, 1000);

      updateCachedFileMtime("/file.ts", 2000);

      const metadata = getCachedFileMetadata("/file.ts");
      expect(metadata?.mtime).toBe(2000);
    });

    it("creates new cache entry if file not cached", async () => {
      updateCachedFileMtime("/new-file.ts", 3000);

      const metadata = getCachedFileMetadata("/new-file.ts");
      expect(metadata).toEqual({ isBinary: false, mtime: 3000 });
    });
  });

  describe("hasLoadedFileThisSession and markFileLoadedThisSession", () => {
    it("tracks files loaded in session", async () => {
      expect(hasLoadedFileThisSession("/file.ts")).toBe(false);

      markFileLoadedThisSession("/file.ts");

      expect(hasLoadedFileThisSession("/file.ts")).toBe(true);
    });
  });

  describe("invalidateFileCache", () => {
    it("removes file from metadata cache", async () => {
      cacheFileMetadata("/file.ts", false, 1000);
      expect(getCachedFileMetadata("/file.ts")).not.toBeNull();

      invalidateFileCache("/file.ts");

      expect(getCachedFileMetadata("/file.ts")).toBeNull();
    });

    it("removes file from loaded files set", async () => {
      markFileLoadedThisSession("/file.ts");
      expect(hasLoadedFileThisSession("/file.ts")).toBe(true);

      invalidateFileCache("/file.ts");

      expect(hasLoadedFileThisSession("/file.ts")).toBe(false);
    });
  });

  describe("clearFileCache", () => {
    it("clears all cached metadata", async () => {
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
    it("caches unsaved content when version differs from disk", async () => {
      cacheUnsavedContent(
        "/file.ts",
        "modified content",
        "original content",
        2, // version
        1, // diskVersion
        []
      );

      const cached = await popUnsavedContent("/file.ts");
      expect(cached).not.toBeNull();
      expect(cached?.content).toBe("modified content");
      expect(cached?.dirty).toBe(true);
      expect(cached?.version).toBe(2);
      expect(cached?.diskVersion).toBe(1);
      // The disk baseline is re-read on restore, so it is not retained.
      expect(cached).not.toHaveProperty("originalContent");
    });

    it("marks entries whose buffer equals disk as clean", async () => {
      cacheUnsavedContent("/file.ts", "same", "same", 3, 1, []);
      expect((await popUnsavedContent("/file.ts"))?.dirty).toBe(false);
    });

    it("evicts only clean entries once the soft cap is exceeded", async () => {
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
      expect(await popUnsavedContent("/f1.ts")).toBeNull();
      expect(await popUnsavedContent("/f3.ts")).toBeNull();
      expect(await popUnsavedContent("/f0.ts")).not.toBeNull();
      expect(await popUnsavedContent("/f2.ts")).not.toBeNull();
      expect(await popUnsavedContent("/extra-a.ts")).not.toBeNull();
      expect(await popUnsavedContent("/extra-b.ts")).not.toBeNull();
    });

    it("never evicts dirty entries even past the cap", async () => {
      const overCap = MAX_UNSAVED_CONTENT_CACHE_SIZE + 5;
      for (let i = 0; i < overCap; i++) {
        cacheUnsavedContent(`/d${i}.ts`, `edited-${i}`, "same", 2, 1, []);
      }
      const stats = getUnsavedContentCacheStats();
      expect(stats.entries).toBe(overCap);
      expect(stats.dirtyEntries).toBe(overCap);
    });

    it("does not cache when version equals disk version", async () => {
      cacheUnsavedContent(
        "/file.ts",
        "same content",
        "same content",
        1, // version
        1, // diskVersion (same)
        []
      );

      const cached = await popUnsavedContent("/file.ts");
      expect(cached).toBeNull();
    });

    it("popUnsavedContent removes entry after retrieval", async () => {
      cacheUnsavedContent("/file.ts", "content", "original", 2, 1, []);

      // First pop returns the content
      expect(await popUnsavedContent("/file.ts")).not.toBeNull();

      // Second pop returns null (already removed)
      expect(await popUnsavedContent("/file.ts")).toBeNull();
    });

    it("returns null for non-cached file", async () => {
      expect(await popUnsavedContent("/uncached.ts")).toBeNull();
    });
  });

  describe("clearUnsavedContentCache", () => {
    it("removes specific file from unsaved content cache", async () => {
      cacheUnsavedContent("/file1.ts", "content1", "orig1", 2, 1, []);
      cacheUnsavedContent("/file2.ts", "content2", "orig2", 2, 1, []);

      clearUnsavedContentCache("/file1.ts");

      expect(await popUnsavedContent("/file1.ts")).toBeNull();
      expect(await popUnsavedContent("/file2.ts")).not.toBeNull();
    });
  });

  describe("subscribeToFileChanges and onExternalFileChange", () => {
    it("notifies subscribers when file changes externally", async () => {
      const callback = vi.fn();
      const unsubscribe = subscribeToFileChanges(callback);

      onExternalFileChange("/changed-file.ts");

      expect(callback).toHaveBeenCalledWith("/changed-file.ts");
      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();
    });

    it("unsubscribe removes callback", async () => {
      const callback = vi.fn();
      const unsubscribe = subscribeToFileChanges(callback);

      unsubscribe();
      onExternalFileChange("/file.ts");

      expect(callback).not.toHaveBeenCalled();
    });

    it("invalidates cache on external change", async () => {
      cacheFileMetadata("/file.ts", false, 1000);
      markFileLoadedThisSession("/file.ts");

      onExternalFileChange("/file.ts");

      expect(getCachedFileMetadata("/file.ts")).toBeNull();
      expect(hasLoadedFileThisSession("/file.ts")).toBe(false);
    });

    it("handles callback errors gracefully", async () => {
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

  describe("unsaved drafts on disk", () => {
    it("moves a dirty buffer's text to a draft file and reads it back on pop", async () => {
      cacheUnsavedContent("/proj/a.ts", "edited text", "original", 2, 1, []);
      // Still in memory until the write lands.
      expect(getUnsavedContentCacheStats()).toMatchObject({
        entries: 1,
        dirtyEntries: 1,
        spilledEntries: 0,
        contentChars: "edited text".length,
      });

      await _flushUnsavedDraftIoForTests();

      expect(fakeFs.dirs.has(DRAFT_DIR)).toBe(true);
      expect(fakeFs.files.size).toBe(1);
      expect([...fakeFs.files.values()]).toEqual(["edited text"]);
      expect(getUnsavedContentCacheStats()).toMatchObject({
        spilledEntries: 1,
        contentChars: 0,
      });

      const restored = await popUnsavedContent("/proj/a.ts");
      expect(restored).toMatchObject({
        content: "edited text",
        version: 2,
        diskVersion: 1,
        dirty: true,
      });
      await _flushUnsavedDraftIoForTests();
      expect(fakeFs.files.size).toBe(0);
      expect(await popUnsavedContent("/proj/a.ts")).toBeNull();
    });

    it("leaves clean entries in memory", async () => {
      cacheUnsavedContent("/proj/clean.ts", "same", "same", 3, 1, []);
      await _flushUnsavedDraftIoForTests();

      expect(fakeFs.files.size).toBe(0);
      expect(getUnsavedContentCacheStats()).toMatchObject({
        spilledEntries: 0,
        contentChars: 4,
      });
    });

    it("keeps the text in memory when the draft cannot be written", async () => {
      fakeFs.failWrites = true;
      cacheUnsavedContent("/proj/b.ts", "unsaved work", "original", 2, 1, []);
      await _flushUnsavedDraftIoForTests();

      expect(getUnsavedContentCacheStats()).toMatchObject({
        spilledEntries: 0,
        contentChars: "unsaved work".length,
      });
      expect((await popUnsavedContent("/proj/b.ts"))?.content).toBe(
        "unsaved work"
      );
    });

    it("serves a pop from memory while the write is in flight and drops the orphaned file", async () => {
      cacheUnsavedContent("/proj/c.ts", "quick switch", "original", 2, 1, []);
      const restored = await popUnsavedContent("/proj/c.ts");
      expect(restored?.content).toBe("quick switch");

      await _flushUnsavedDraftIoForTests();
      expect(fakeFs.files.size).toBe(0);
    });

    it("removes the draft file when the entry is cleared", async () => {
      cacheUnsavedContent("/proj/d.ts", "to discard", "original", 2, 1, []);
      await _flushUnsavedDraftIoForTests();
      expect(fakeFs.files.size).toBe(1);

      clearUnsavedContentCache("/proj/d.ts");
      await _flushUnsavedDraftIoForTests();
      expect(fakeFs.files.size).toBe(0);
    });

    it("keeps only the newest draft when the same path is cached again", async () => {
      cacheUnsavedContent("/proj/e.ts", "first", "original", 2, 1, []);
      cacheUnsavedContent("/proj/e.ts", "second", "original", 3, 1, []);
      await _flushUnsavedDraftIoForTests();

      expect([...fakeFs.files.values()]).toEqual(["second"]);
      expect((await popUnsavedContent("/proj/e.ts"))?.content).toBe("second");
      await _flushUnsavedDraftIoForTests();
      expect(fakeFs.files.size).toBe(0);
    });

    it("sweeps drafts left behind by earlier runs, but not recent ones", async () => {
      fakeFs.dirs.add(DRAFT_DIR);
      fakeFs.files.set(`${DRAFT_DIR}/stale.txt`, "old");
      fakeFs.mtimes.set(
        `${DRAFT_DIR}/stale.txt`,
        Date.now() - STALE_UNSAVED_DRAFT_MS - 1000
      );
      fakeFs.files.set(`${DRAFT_DIR}/recent.txt`, "other instance");
      fakeFs.mtimes.set(`${DRAFT_DIR}/recent.txt`, Date.now());

      cacheUnsavedContent("/proj/f.ts", "new", "original", 2, 1, []);
      await _flushUnsavedDraftIoForTests();

      expect(fakeFs.files.has(`${DRAFT_DIR}/stale.txt`)).toBe(false);
      expect(fakeFs.files.has(`${DRAFT_DIR}/recent.txt`)).toBe(true);
      expect(fakeFs.files.size).toBe(2);
    });
  });

  describe("cache eviction (FIFO)", () => {
    it("evicts oldest entries when metadata cache exceeds MAX_METADATA_CACHE_SIZE", async () => {
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

    it("evicts from loadedFilesThisSession when exceeds MAX_LOADED_FILES_SIZE", async () => {
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

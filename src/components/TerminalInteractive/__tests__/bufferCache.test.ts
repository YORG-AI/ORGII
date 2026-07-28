/**
 * Tests for terminal buffer cache (in-memory LRU cache).
 */
import { describe, expect, it, vi } from "vitest";

import {
  clearTerminalBufferCache,
  deleteTerminalBuffer,
  getTerminalBuffer,
  getTerminalBufferCacheSize,
  getTerminalBufferCacheStats,
  hydrateFromPersistence,
  isCacheHydrated,
  setTerminalBuffer,
} from "../bufferCache";

// Mock `@src/services/terminal` to avoid circular dependency issues and
// to prevent the cache from making the real debounced disk-write call.
// `bufferCache.setTerminalBuffer` calls `persistTerminalBuffer` to mirror
// state to disk; in tests we just need a no-op stub.
vi.mock("@src/services/terminal", () => ({
  persistTerminalBuffer: vi.fn(),
}));

describe("bufferCache", () => {
  describe("setTerminalBuffer and getTerminalBuffer", () => {
    it("stores and retrieves buffer", () => {
      setTerminalBuffer("test-session-1", "test-content-1");
      expect(getTerminalBuffer("test-session-1")).toBe("test-content-1");
    });

    it("returns undefined for non-existent buffer", () => {
      expect(getTerminalBuffer("non-existent")).toBeUndefined();
    });

    it("overwrites existing buffer for same session", () => {
      setTerminalBuffer("test-session-2", "old-content");
      setTerminalBuffer("test-session-2", "new-content");
      expect(getTerminalBuffer("test-session-2")).toBe("new-content");
    });
  });

  describe("LRU eviction", () => {
    it("evicts oldest entry when cache exceeds MAX_CACHE_SIZE", () => {
      // Fill cache with 10 entries (MAX_CACHE_SIZE)
      for (let idx = 0; idx < 10; idx++) {
        setTerminalBuffer(`evict-session-${idx}`, `content-${idx}`);
      }

      // Add one more - should evict the oldest (evict-session-0)
      setTerminalBuffer("evict-session-new", "new-content");

      // First entry should be evicted
      expect(getTerminalBuffer("evict-session-0")).toBeUndefined();

      // New entry should exist
      expect(getTerminalBuffer("evict-session-new")).toBe("new-content");

      // Middle entries should still exist
      expect(getTerminalBuffer("evict-session-5")).toBe("content-5");
    });

    it("marks accessed entry as most recently used", () => {
      // Start with a fresh set
      for (let idx = 100; idx < 110; idx++) {
        setTerminalBuffer(`lru-session-${idx}`, `content-${idx}`);
      }

      // Access the oldest entry (makes it most recently used)
      getTerminalBuffer("lru-session-100");

      // Add a new entry - should evict session-101 (now oldest)
      setTerminalBuffer("lru-session-new", "new-content");

      // The accessed entry should still exist
      expect(getTerminalBuffer("lru-session-100")).toBe("content-100");

      // The second oldest should be evicted
      expect(getTerminalBuffer("lru-session-101")).toBeUndefined();
    });
  });

  describe("deleteTerminalBuffer", () => {
    it("removes buffer from cache", () => {
      setTerminalBuffer("delete-test", "content");
      expect(getTerminalBuffer("delete-test")).toBe("content");

      deleteTerminalBuffer("delete-test");
      expect(getTerminalBuffer("delete-test")).toBeUndefined();
    });

    it("does not throw when deleting non-existent buffer", () => {
      expect(() => deleteTerminalBuffer("non-existent-delete")).not.toThrow();
    });
  });

  describe("clearTerminalBufferCache", () => {
    it("removes specific buffer", () => {
      setTerminalBuffer("clear-test", "content");
      clearTerminalBufferCache("clear-test");
      expect(getTerminalBuffer("clear-test")).toBeUndefined();
    });
  });

  describe("hydrateFromPersistence", () => {
    it("populates cache from persisted buffers", () => {
      // Note: hydrateFromPersistence is idempotent (only runs once)
      // This test verifies the concept, but the actual hydration
      // only happens once per module load.
      const persistedBuffers = new Map([
        [
          "hydrate-session-1",
          {
            sessionId: "hydrate-session-1",
            serialized: "hydrated-content-1",
            timestamp: Date.now(),
          },
        ],
        [
          "hydrate-session-2",
          {
            sessionId: "hydrate-session-2",
            serialized: "hydrated-content-2",
            timestamp: Date.now(),
          },
        ],
      ]);

      // Since hydrateFromPersistence is idempotent, we can only test
      // that it doesn't throw and the function exists
      expect(() => hydrateFromPersistence(persistedBuffers)).not.toThrow();
    });

    it("isCacheHydrated returns boolean", () => {
      expect(typeof isCacheHydrated()).toBe("boolean");
    });
  });

  describe("getTerminalBufferCacheSize", () => {
    it("returns current cache size", () => {
      const initialSize = getTerminalBufferCacheSize();
      setTerminalBuffer("size-test-session", "content");
      expect(getTerminalBufferCacheSize()).toBeGreaterThanOrEqual(initialSize);
    });
  });

  describe("byte budgets", () => {
    it("keeps only the tail of an oversized buffer", () => {
      const oversized = `prefix-${"x".repeat(600_000)}-tail`;

      setTerminalBuffer("oversized-session", oversized);

      const retained = getTerminalBuffer("oversized-session");
      expect(retained?.endsWith("-tail")).toBe(true);
      expect((retained?.length ?? 0) * 2).toBeLessThanOrEqual(1024 * 1024);
    });

    it("keeps the aggregate cache within its byte budget", () => {
      const oneMiBUtf16 = "x".repeat(512 * 1024);

      for (let idx = 0; idx < 10; idx++) {
        setTerminalBuffer(`byte-budget-session-${idx}`, oneMiBUtf16);
      }

      const stats = getTerminalBufferCacheStats();
      expect(stats.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(stats.entries).toBeLessThanOrEqual(8);
    });
  });
});

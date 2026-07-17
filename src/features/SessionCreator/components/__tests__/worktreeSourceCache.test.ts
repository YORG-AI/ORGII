import { describe, expect, it } from "vitest";

import {
  WORKTREE_GITHUB_CACHE_TTL_MS,
  WORKTREE_SOURCE_CACHE_MAX_ENTRIES,
  createInflightRegistry,
  getWorktreeCacheFreshness,
  isWorktreeCacheFresh,
  resolveWorktreeRepoKey,
  writeWorktreeCacheEntry,
} from "../worktreeSourceCache";

describe("resolveWorktreeRepoKey", () => {
  it("prefers repoId over repoPath", () => {
    expect(resolveWorktreeRepoKey("repo-1", "/tmp/foo")).toBe("id:repo-1");
  });

  it("falls back to repoPath when repoId is missing", () => {
    expect(resolveWorktreeRepoKey(undefined, "/tmp/foo")).toBe("path:/tmp/foo");
  });

  it("returns null when neither is available", () => {
    expect(resolveWorktreeRepoKey("", "  ")).toBeNull();
  });
});

describe("getWorktreeCacheFreshness", () => {
  const entry = { fetchedAt: 1_000 };

  it("classifies missing entries", () => {
    expect(getWorktreeCacheFreshness(undefined, 2_000, 100)).toBe("missing");
  });

  it("classifies fresh entries within TTL", () => {
    expect(
      getWorktreeCacheFreshness(entry, 1_000 + 50, WORKTREE_GITHUB_CACHE_TTL_MS)
    ).toBe("fresh");
    expect(
      isWorktreeCacheFresh(entry, 1_000 + 50, WORKTREE_GITHUB_CACHE_TTL_MS)
    ).toBe(true);
  });

  it("classifies stale entries past TTL", () => {
    expect(
      getWorktreeCacheFreshness(
        entry,
        1_000 + WORKTREE_GITHUB_CACHE_TTL_MS,
        WORKTREE_GITHUB_CACHE_TTL_MS
      )
    ).toBe("stale");
  });
});

describe("writeWorktreeCacheEntry", () => {
  it("evicts oldest entries beyond max size", () => {
    let map = new Map<string, { fetchedAt: number }>();
    for (let i = 0; i < WORKTREE_SOURCE_CACHE_MAX_ENTRIES + 2; i++) {
      map = writeWorktreeCacheEntry(map, `key-${i}`, { fetchedAt: i });
    }
    expect(map.size).toBe(WORKTREE_SOURCE_CACHE_MAX_ENTRIES);
    expect(map.has("key-0")).toBe(false);
    expect(map.has("key-1")).toBe(false);
    expect(map.has(`key-${WORKTREE_SOURCE_CACHE_MAX_ENTRIES + 1}`)).toBe(true);
  });
});

describe("createInflightRegistry", () => {
  it("de-dupes concurrent loads for the same key", async () => {
    const registry = createInflightRegistry<number>();
    let runs = 0;
    const factory = async () => {
      runs += 1;
      return 42;
    };

    const [a, b] = await Promise.all([
      registry.run("repo-a", factory),
      registry.run("repo-a", factory),
    ]);

    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(runs).toBe(1);
    expect(registry.size()).toBe(0);
  });
});

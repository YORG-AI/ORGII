import { createStore } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreScopedSnapshotCache } from "../storeScopedSnapshotCache";

describe("StoreScopedSnapshotCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("isolates values by Jotai store", () => {
    const cache = new StoreScopedSnapshotCache<string, string>(2);
    const firstStore = createStore();
    const secondStore = createStore();

    cache.set(firstStore, "list", "first");

    expect(cache.get(firstStore, "list")).toBe("first");
    expect(cache.get(secondStore, "list")).toBeUndefined();
  });

  it("evicts the least recently used entry at the configured bound", () => {
    const cache = new StoreScopedSnapshotCache<string, number>(2);
    const store = createStore();

    cache.set(store, "first", 1);
    cache.set(store, "second", 2);
    expect(cache.get(store, "first")).toBe(1);
    cache.set(store, "third", 3);

    expect(cache.get(store, "second")).toBeUndefined();
    expect(cache.get(store, "first")).toBe(1);
    expect(cache.get(store, "third")).toBe(3);
  });

  it("expires retained snapshots on read", () => {
    vi.useFakeTimers();
    const cache = new StoreScopedSnapshotCache<string, number>(2, 1_000);
    const store = createStore();

    cache.set(store, "list", 1);
    vi.advanceTimersByTime(1_001);

    expect(cache.get(store, "list")).toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { ScopedResourceCache } from "./scopedResourceCache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ScopedResourceCache", () => {
  it("shares an equal in-flight request and retains the settled result", async () => {
    const cache = new ScopedResourceCache<string>({ maxEntries: 2 });
    const pending = deferred<string>();
    const loader = vi.fn(() => pending.promise);

    const first = cache.load("repo:a", loader);
    const second = cache.load("repo:a", loader);

    expect(first).toBe(second);
    expect(loader).toHaveBeenCalledTimes(1);

    pending.resolve("ready");
    await expect(first).resolves.toBe("ready");
    await expect(cache.load("repo:a", loader)).resolves.toBe("ready");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("keeps stale data readable while one background replacement runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const cache = new ScopedResourceCache<string>({
      maxAgeMs: 100,
      maxEntries: 2,
    });
    cache.set("repo:a", "old");
    vi.setSystemTime(1_200);

    const pending = deferred<string>();
    const replacement = cache.load("repo:a", () => pending.promise);

    expect(cache.get("repo:a")).toMatchObject({
      stale: true,
      value: "old",
    });

    pending.resolve("new");
    await expect(replacement).resolves.toBe("new");
    expect(cache.get("repo:a")).toMatchObject({
      stale: false,
      value: "new",
    });
  });

  it("enforces both LRU entry and byte bounds", () => {
    const cache = new ScopedResourceCache<string>({
      estimateSize: (value) => value.length,
      maxBytes: 5,
      maxEntries: 2,
      maxEntryBytes: 4,
    });

    cache.set("a", "aa");
    cache.set("b", "bb");
    cache.get("a");
    cache.set("c", "cc");

    expect(cache.get("b")).toBeNull();
    expect(cache.get("a")?.value).toBe("aa");
    expect(cache.get("c")?.value).toBe("cc");
    expect(cache.getStats()).toMatchObject({ bytes: 4, entries: 2 });

    cache.set("oversized", "12345");
    expect(cache.get("oversized")).toBeNull();
    expect(cache.getStats()).toMatchObject({ bytes: 4, entries: 2 });
  });

  it("does not cache rejected or explicitly excluded results", async () => {
    const cache = new ScopedResourceCache<string | null>({ maxEntries: 2 });
    const failure = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(cache.load("repo:a", failure)).rejects.toThrow("offline");
    expect(cache.getStats()).toMatchObject({ entries: 0, inFlight: 0 });

    const empty = vi.fn().mockResolvedValue(null);
    await cache.load("repo:a", empty, {
      shouldCache: (value) => value !== null,
    });
    await cache.load("repo:a", empty, {
      shouldCache: (value) => value !== null,
    });
    expect(empty).toHaveBeenCalledTimes(2);
  });

  it("bounds coalescing handles when unrelated requests remain pending", () => {
    const cache = new ScopedResourceCache<string>({
      maxEntries: 2,
      maxInFlight: 2,
    });

    void cache.load("repo:a", () => new Promise(() => undefined));
    void cache.load("repo:b", () => new Promise(() => undefined));
    void cache.load("repo:c", () => new Promise(() => undefined));

    expect(cache.getStats()).toMatchObject({ inFlight: 2, maxInFlight: 2 });
  });

  it("does not let an evicted in-flight handle publish a late cache value", async () => {
    const cache = new ScopedResourceCache<string>({
      maxEntries: 2,
      maxInFlight: 1,
    });
    const oldRequest = deferred<string>();
    const newRequest = deferred<string>();

    const oldResult = cache.load("repo:old", () => oldRequest.promise);
    const newResult = cache.load("repo:new", () => newRequest.promise);
    newRequest.resolve("new");
    await expect(newResult).resolves.toBe("new");
    oldRequest.resolve("old");
    await expect(oldResult).resolves.toBe("old");

    expect(cache.get("repo:old")).toBeNull();
    expect(cache.get("repo:new")?.value).toBe("new");
  });
});

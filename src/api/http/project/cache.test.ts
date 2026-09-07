import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cachedRead,
  invalidateCache,
  readCachedSnapshot,
  subscribeCachedSnapshot,
} from "./cache";

describe("project read cache invalidation fencing", () => {
  beforeEach(() => {
    invalidateCache();
  });

  it("deduplicates concurrent reads while the cache generation is stable", async () => {
    let resolveRead: ((value: string) => void) | undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        })
    );

    const first = cachedRead("project:workitems", fetcher);
    const second = cachedRead("project:workitems", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveRead?.("current");
    await expect(Promise.all([first, second])).resolves.toEqual([
      "current",
      "current",
    ]);
  });

  it("publishes successful reads and scoped invalidation to cache projections", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCachedSnapshot(
      "project:quick-actions",
      listener
    );

    await expect(
      cachedRead("project:quick-actions", async () => ["review"])
    ).resolves.toEqual(["review"]);
    expect(readCachedSnapshot("project:quick-actions")).toEqual(["review"]);
    expect(listener).toHaveBeenCalledTimes(1);

    invalidateCache("project");
    expect(readCachedSnapshot("project:quick-actions")).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("never lets a pre-invalidation Promise resurrect or return stale data", async () => {
    let resolveStale: ((value: string) => void) | undefined;
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveStale = resolve;
          })
      )
      .mockResolvedValue("fresh");

    const crossedMutation = cachedRead("project:workitems", fetcher);
    invalidateCache();
    const afterMutation = cachedRead("project:workitems", fetcher);
    await expect(afterMutation).resolves.toBe("fresh");

    resolveStale?.("stale");
    await expect(crossedMutation).resolves.toBe("fresh");
    await expect(cachedRead("project:workitems", fetcher)).resolves.toBe(
      "fresh"
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not restart an unrelated project read after scoped invalidation", async () => {
    let resolveStaleAlpha: ((value: string) => void) | undefined;
    let resolveBeta: ((value: string) => void) | undefined;
    const alphaFetcher = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveStaleAlpha = resolve;
          })
      )
      .mockResolvedValue("alpha-fresh");
    const betaFetcher = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveBeta = resolve;
        })
    );

    const alphaBeforeMutation = cachedRead("alpha:workitems", alphaFetcher);
    const betaBeforeMutation = cachedRead("beta:workitems", betaFetcher);
    await Promise.resolve();
    invalidateCache("alpha");
    const alphaAfterMutation = cachedRead("alpha:workitems", alphaFetcher);

    resolveBeta?.("beta-current");
    await expect(betaBeforeMutation).resolves.toBe("beta-current");
    expect(betaFetcher).toHaveBeenCalledTimes(1);

    await expect(alphaAfterMutation).resolves.toBe("alpha-fresh");
    resolveStaleAlpha?.("alpha-stale");
    await expect(alphaBeforeMutation).resolves.toBe("alpha-fresh");
    expect(alphaFetcher).toHaveBeenCalledTimes(2);
  });
});

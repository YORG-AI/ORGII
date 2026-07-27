import { beforeEach, describe, expect, it, vi } from "vitest";

import { cachedRead, invalidateCache } from "./cache";

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

  it("can deduplicate only the active request without caching its result", async () => {
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");

    const first = cachedRead("project:filtered", fetcher, { maxAgeMs: 0 });
    const joined = cachedRead("project:filtered", fetcher, { maxAgeMs: 0 });
    await expect(Promise.all([first, joined])).resolves.toEqual([
      "first",
      "first",
    ]);
    await expect(
      cachedRead("project:filtered", fetcher, { maxAgeMs: 0 })
    ).resolves.toBe("second");
    expect(fetcher).toHaveBeenCalledTimes(2);
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
});

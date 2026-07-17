import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GITHUB_LIST_CACHE_TTL_MS,
  coalesceGitHubListRequest,
  getCachedPrs,
  isIssueCacheStale,
  isPrCacheStale,
  setCachedPrs,
  updateCachedClosedIssues,
  updateCachedOpenIssues,
} from "./githubListCache";

describe("global GitHub list cache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps list entries fresh for ten minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T06:00:00.000Z"));
    const repoKey = `ttl-${crypto.randomUUID()}`;

    setCachedPrs(repoKey, []);
    expect(isPrCacheStale(repoKey)).toBe(false);

    vi.advanceTimersByTime(GITHUB_LIST_CACHE_TTL_MS + 1);
    expect(isPrCacheStale(repoKey)).toBe(true);
  });

  it("keeps open and closed PR lists independently lazy", () => {
    const repoKey = `states-${crypto.randomUUID()}`;

    setCachedPrs(repoKey, [], "open");

    expect(getCachedPrs(repoKey, "open")).not.toBeNull();
    expect(getCachedPrs(repoKey, "closed")).toBeNull();
    expect(isPrCacheStale(repoKey, "closed")).toBe(true);
  });

  it("tracks issue freshness independently for open and closed lists", () => {
    const repoKey = `issue-states-${crypto.randomUUID()}`;

    updateCachedOpenIssues(repoKey, []);
    expect(isIssueCacheStale(repoKey, "open")).toBe(false);
    expect(isIssueCacheStale(repoKey, "closed")).toBe(true);

    updateCachedClosedIssues(repoKey, []);
    expect(isIssueCacheStale(repoKey, "closed")).toBe(false);
  });

  it("coalesces in-flight requests and releases them after settlement", async () => {
    const requestFactory = vi.fn(async () => ["loaded"]);
    const key = `request-${crypto.randomUUID()}`;

    const first = coalesceGitHubListRequest(key, requestFactory);
    const second = coalesceGitHubListRequest(key, requestFactory);

    expect(second).toBe(first);
    await expect(first).resolves.toEqual(["loaded"]);
    expect(requestFactory).toHaveBeenCalledTimes(1);

    await coalesceGitHubListRequest(key, requestFactory);
    expect(requestFactory).toHaveBeenCalledTimes(2);
  });
});

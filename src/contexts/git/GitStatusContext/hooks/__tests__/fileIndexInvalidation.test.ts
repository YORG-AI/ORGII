import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFileIndexInvalidationScheduler,
  fileChangeInvalidatesPathIndex,
  repoChangeInvalidatesPathIndex,
} from "../fileIndexInvalidation";

describe("file index invalidation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst into one invalidation per workspace root", async () => {
    const invalidate = vi.fn().mockResolvedValue(undefined);
    const scheduler = createFileIndexInvalidationScheduler(invalidate, 250);

    scheduler.schedule("/repo-a");
    scheduler.schedule("/repo-a");
    scheduler.schedule("/repo-b");
    vi.advanceTimersByTime(249);
    expect(invalidate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith("/repo-a");
    expect(invalidate).toHaveBeenCalledWith("/repo-b");
  });

  it("drops pending work after disposal", () => {
    const invalidate = vi.fn().mockResolvedValue(undefined);
    const scheduler = createFileIndexInvalidationScheduler(invalidate, 250);

    scheduler.schedule("/repo-a");
    scheduler.dispose();
    vi.advanceTimersByTime(500);

    expect(invalidate).not.toHaveBeenCalled();
  });

  it("reports asynchronous invalidation failures", async () => {
    const error = new Error("IPC unavailable");
    const onError = vi.fn();
    const scheduler = createFileIndexInvalidationScheduler(
      vi.fn().mockRejectedValue(error),
      1,
      onError
    );

    scheduler.schedule("/repo-a");
    await vi.advanceTimersByTimeAsync(1);

    expect(onError).toHaveBeenCalledWith(error);
  });

  it("ignores content-only modifications", () => {
    expect(fileChangeInvalidatesPathIndex("modified")).toBe(false);
    expect(fileChangeInvalidatesPathIndex("created")).toBe(true);
    expect(fileChangeInvalidatesPathIndex("deleted")).toBe(true);
    expect(fileChangeInvalidatesPathIndex("renamed")).toBe(true);
    expect(fileChangeInvalidatesPathIndex(undefined)).toBe(true);
  });

  it("only invalidates for aggregate filesystem changes", () => {
    expect(repoChangeInvalidatesPathIndex("files")).toBe(true);
    expect(repoChangeInvalidatesPathIndex("git_meta")).toBe(false);
    expect(repoChangeInvalidatesPathIndex("branch")).toBe(false);
    expect(repoChangeInvalidatesPathIndex(undefined)).toBe(false);
  });
});

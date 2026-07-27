import { afterEach, describe, expect, it, vi } from "vitest";

import { createEventStoreCachePersistenceScheduler } from "../sessionSyncLifecycle";

describe("EventStore cache persistence scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("owns no recurring timer while idle and flushes after the quiet window", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const scheduler = createEventStoreCachePersistenceScheduler(
      save,
      2_000,
      30_000
    );

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    scheduler.markDirty(1);
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    scheduler.dispose();
  });

  it("enforces the maximum durability delay during sustained changes", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const scheduler = createEventStoreCachePersistenceScheduler(
      save,
      2_000,
      30_000
    );

    for (let second = 0; second < 30; second += 1) {
      scheduler.markDirty(second);
      await vi.advanceTimersByTimeAsync(1_000);
    }

    expect(save).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it("coalesces changes during an in-flight write into one follow-up", async () => {
    vi.useFakeTimers();
    let finishFirst: (() => void) | undefined;
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirst = resolve;
          })
      )
      .mockResolvedValue(undefined);
    const scheduler = createEventStoreCachePersistenceScheduler(
      save,
      100,
      1_000
    );

    scheduler.markDirty(1);
    await vi.advanceTimersByTimeAsync(100);
    scheduler.markDirty(2);
    scheduler.markDirty(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(save).toHaveBeenCalledTimes(1);

    finishFirst?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(save).toHaveBeenCalledTimes(2);

    scheduler.dispose();
  });
});

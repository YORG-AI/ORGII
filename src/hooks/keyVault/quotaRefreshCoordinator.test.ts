import { afterEach, describe, expect, it, vi } from "vitest";

import {
  quotaRefreshCoordinatorInternals,
  runSharedQuotaRefresh,
} from "./quotaRefreshCoordinator";

afterEach(() => {
  quotaRefreshCoordinatorInternals.clear();
});

describe("runSharedQuotaRefresh", () => {
  it("shares one in-flight request per account", async () => {
    let resolveRefresh: ((value: boolean) => void) | undefined;
    const runner = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRefresh = resolve;
        })
    );

    const first = runSharedQuotaRefresh("cursor:one", false, runner);
    const second = runSharedQuotaRefresh("cursor:one", false, runner);

    expect(second).toBe(first);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(quotaRefreshCoordinatorInternals.size()).toBe(1);

    resolveRefresh?.(true);
    await expect(first).resolves.toBe(true);
    expect(quotaRefreshCoordinatorInternals.size()).toBe(0);
  });

  it("does not coalesce different accounts", async () => {
    const runner = vi.fn().mockResolvedValue(true);

    await Promise.all([
      runSharedQuotaRefresh("cursor:one", false, runner),
      runSharedQuotaRefresh("cursor:two", false, runner),
    ]);

    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("evicts failed requests so a later retry can run", async () => {
    const runner = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(true);

    await expect(
      runSharedQuotaRefresh("cursor:one", false, runner)
    ).rejects.toThrow("offline");
    await expect(
      runSharedQuotaRefresh("cursor:one", false, runner)
    ).resolves.toBe(true);

    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("queues one forced refresh behind a cache-eligible request", async () => {
    const resolvers: Array<(value: boolean) => void> = [];
    const runner = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolvers.push(resolve);
        })
    );

    const cached = runSharedQuotaRefresh("cursor:one", false, runner);
    const forced = runSharedQuotaRefresh("cursor:one", true, runner);
    const secondForced = runSharedQuotaRefresh("cursor:one", true, runner);

    expect(forced).toBe(secondForced);
    expect(runner).toHaveBeenCalledTimes(1);

    resolvers[0](true);
    await expect(cached).resolves.toBe(true);
    await Promise.resolve();
    expect(runner).toHaveBeenCalledTimes(2);

    resolvers[1](true);
    await expect(forced).resolves.toBe(true);
    expect(quotaRefreshCoordinatorInternals.size()).toBe(0);
  });
});

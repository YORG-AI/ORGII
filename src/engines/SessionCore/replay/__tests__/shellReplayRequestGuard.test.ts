import { describe, expect, it, vi } from "vitest";

import {
  ShellReplayRequestGuard,
  readShellReplayRangeIfCurrent,
  scheduleShellReplayPrefetch,
  shouldShowShellReplayLoadingPlaceholder,
} from "../shellReplayRequestGuard";

describe("shell replay async UI request guard", () => {
  it("debounces 16ms Snapshot scrubbing without starting a range read", () => {
    vi.useFakeTimers();
    const readRange = vi.fn();
    let cancel: () => void = () => undefined;

    for (let frame = 0; frame < 6; frame += 1) {
      cancel();
      cancel = scheduleShellReplayPrefetch(readRange, 100);
      vi.advanceTimersByTime(16);
    }
    expect(readRange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(readRange).toHaveBeenCalledTimes(1);
    cancel();
    vi.useRealTimers();
  });

  it("drops a delayed response after A to B to A cursor changes", async () => {
    vi.useFakeTimers();
    const guard = new ShellReplayRequestGuard();
    guard.setIdentity("snapshot-a");
    const staleTicket = guard.beginRequest();
    const staleRead = readShellReplayRangeIfCurrent(
      guard,
      staleTicket,
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("stale-a"), 2_000);
        })
    );

    guard.setIdentity("snapshot-b");
    guard.setIdentity("snapshot-a");
    const currentTicket = guard.beginRequest();
    const currentRead = readShellReplayRangeIfCurrent(
      guard,
      currentTicket,
      async () => "current-a"
    );

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(staleRead).resolves.toBeNull();
    await expect(currentRead).resolves.toBe("current-a");
    vi.useRealTimers();
  });

  it("shows loading placeholders only for user-entered uncached regions", () => {
    expect(shouldShowShellReplayLoadingPlaceholder(null)).toBe(false);
    expect(shouldShowShellReplayLoadingPlaceholder("initial")).toBe(false);
    expect(shouldShowShellReplayLoadingPlaceholder("prepend")).toBe(true);
    expect(shouldShowShellReplayLoadingPlaceholder("append")).toBe(true);
  });
});

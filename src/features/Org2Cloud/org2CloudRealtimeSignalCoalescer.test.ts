import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Org2CloudRealtimeSignalCoalescer,
  REALTIME_SIGNAL_COALESCE_MS,
} from "./org2CloudRealtimeSignalCoalescer";

describe("Org2CloudRealtimeSignalCoalescer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the first server invalidation immediately", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const refresh = vi.fn();
    const scheduler = new Org2CloudRealtimeSignalCoalescer<string>();

    scheduler.schedule("workItems", refresh);

    expect(refresh).toHaveBeenCalledTimes(1);
    scheduler.reset();
  });

  it("delivers a post-subscribe Work Item invalidation within the live window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const refresh = vi.fn();
    const scheduler = new Org2CloudRealtimeSignalCoalescer<string>();
    scheduler.markHandled(["workItems"]);

    scheduler.schedule("workItems", refresh);
    vi.advanceTimersByTime(REALTIME_SIGNAL_COALESCE_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    scheduler.reset();
  });

  it("shares one trailing timer across a burst and disposes it on reset", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const firstRefresh = vi.fn();
    const duplicateRefresh = vi.fn();
    const scheduler = new Org2CloudRealtimeSignalCoalescer<string>();
    scheduler.markHandled(["workItems"]);

    scheduler.schedule("workItems", firstRefresh);
    scheduler.schedule("workItems", duplicateRefresh);
    expect(vi.getTimerCount()).toBe(1);

    scheduler.reset();
    vi.runAllTimers();
    expect(firstRefresh).not.toHaveBeenCalled();
    expect(duplicateRefresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

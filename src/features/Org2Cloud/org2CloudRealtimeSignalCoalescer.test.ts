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

  it("honors a per-call window override for leading and trailing runs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const refresh = vi.fn();
    const scheduler = new Org2CloudRealtimeSignalCoalescer<string>();

    scheduler.schedule("sessions", refresh, 15_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    scheduler.schedule("sessions", refresh, 15_000);
    vi.advanceTimersByTime(14_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(2);

    scheduler.reset();
  });

  it("returns to the default window once no override is passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const refresh = vi.fn();
    const scheduler = new Org2CloudRealtimeSignalCoalescer<string>();

    scheduler.schedule("sessions", refresh, 15_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(REALTIME_SIGNAL_COALESCE_MS);

    scheduler.schedule("sessions", refresh);
    expect(refresh).toHaveBeenCalledTimes(2);

    scheduler.reset();
  });

  it("keeps an already-armed trailing timer over a later wider override", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const refresh = vi.fn();
    const scheduler = new Org2CloudRealtimeSignalCoalescer<string>();
    scheduler.markHandled(["sessions"]);

    scheduler.schedule("sessions", refresh);
    scheduler.schedule("sessions", refresh, 15_000);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(REALTIME_SIGNAL_COALESCE_MS);
    expect(refresh).toHaveBeenCalledTimes(1);

    scheduler.reset();
  });
});

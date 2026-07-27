import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppUpdaterScheduler } from "./appUpdaterScheduler";

async function flushSchedulerPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("AppUpdaterScheduler", () => {
  let documentTarget: EventTarget & { visibilityState: string };
  let navigatorState: { onLine: boolean };

  beforeEach(() => {
    vi.useFakeTimers();
    const windowTarget = new EventTarget();
    documentTarget = Object.assign(new EventTarget(), {
      visibilityState: "visible",
    });
    navigatorState = { onLine: true };
    vi.stubGlobal(
      "window",
      Object.assign(windowTarget, {
        clearTimeout: globalThis.clearTimeout,
        setTimeout: globalThis.setTimeout,
      })
    );
    vi.stubGlobal("document", documentTarget);
    vi.stubGlobal("navigator", navigatorState);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("debounces focus and visibility events into one foreground check", async () => {
    const onCheck = vi.fn();
    const scheduler = new AppUpdaterScheduler({
      startupDelayMs: 10_000,
      intervalMs: 20_000,
      foregroundDebounceMs: 500,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 4_000,
      random: () => 0.5,
    });
    scheduler.start(onCheck);

    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(499);
    expect(onCheck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await flushSchedulerPromises();

    expect(onCheck).toHaveBeenCalledOnce();
    expect(onCheck).toHaveBeenCalledWith("foreground");
    scheduler.stop();
  });

  it("stops startup, interval, and event checks", () => {
    const onCheck = vi.fn();
    const scheduler = new AppUpdaterScheduler({
      startupDelayMs: 1_000,
      intervalMs: 2_000,
      foregroundDebounceMs: 100,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 4_000,
      random: () => 0.5,
    });
    scheduler.start(onCheck);
    scheduler.stop();

    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    vi.advanceTimersByTime(10_000);

    expect(onCheck).not.toHaveBeenCalled();
  });

  it("can start active-use scheduling without a startup install", async () => {
    const onCheck = vi.fn();
    const scheduler = new AppUpdaterScheduler({
      startupDelayMs: null,
      intervalMs: 2_000,
      foregroundDebounceMs: 100,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 4_000,
      random: () => 0.5,
    });
    scheduler.start(onCheck);

    vi.advanceTimersByTime(1_999);
    expect(onCheck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await flushSchedulerPromises();

    expect(onCheck).toHaveBeenCalledOnce();
    expect(onCheck).toHaveBeenCalledWith("interval");
    scheduler.stop();
  });

  it("single-flights a failed run and retries with capped exponential backoff", async () => {
    const onCheck = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("offline"));
    const scheduler = new AppUpdaterScheduler({
      startupDelayMs: 0,
      intervalMs: 60_000,
      foregroundDebounceMs: 100,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 2_000,
      random: () => 0.5,
    });
    scheduler.start(onCheck);

    vi.advanceTimersByTime(0);
    await flushSchedulerPromises();
    expect(onCheck).toHaveBeenCalledOnce();

    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(999);
    expect(onCheck).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    await flushSchedulerPromises();
    expect(onCheck).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1_999);
    expect(onCheck).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    await flushSchedulerPromises();
    expect(onCheck).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(1_999);
    expect(onCheck).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1);
    await flushSchedulerPromises();
    expect(onCheck).toHaveBeenCalledTimes(4);
    scheduler.stop();
  });

  it("coalesces startup, focus, and online triggers while a run is active", async () => {
    let resolveCheck: (() => void) | undefined;
    const onCheck = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCheck = resolve;
        })
    );
    const scheduler = new AppUpdaterScheduler({
      startupDelayMs: 0,
      intervalMs: 60_000,
      foregroundDebounceMs: 100,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 4_000,
      random: () => 0.5,
    });
    scheduler.start(onCheck);
    vi.advanceTimersByTime(0);
    await flushSchedulerPromises();

    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    vi.advanceTimersByTime(100);
    await flushSchedulerPromises();
    expect(onCheck).toHaveBeenCalledOnce();

    resolveCheck?.();
    await flushSchedulerPromises();
    expect(onCheck).toHaveBeenCalledOnce();
    scheduler.stop();
  });

  it("supports an explicit retry-now without leaving the backoff timer armed", async () => {
    const onCheck = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const scheduler = new AppUpdaterScheduler({
      startupDelayMs: 0,
      intervalMs: 60_000,
      foregroundDebounceMs: 100,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 4_000,
      random: () => 0.5,
    });
    scheduler.start(onCheck);
    vi.advanceTimersByTime(0);
    await flushSchedulerPromises();

    scheduler.retryNow();
    await flushSchedulerPromises();
    expect(onCheck).toHaveBeenCalledTimes(2);
    expect(onCheck).toHaveBeenLastCalledWith("retry");

    vi.advanceTimersByTime(1_000);
    await flushSchedulerPromises();
    expect(onCheck).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("pauses interval and retry timers while hidden, then retries once", async () => {
    const onCheck = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const scheduler = new AppUpdaterScheduler({
      startupDelayMs: 0,
      intervalMs: 2_000,
      foregroundDebounceMs: 100,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 4_000,
      random: () => 0.5,
    });
    scheduler.start(onCheck);
    vi.advanceTimersByTime(0);
    await flushSchedulerPromises();

    documentTarget.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(10_000);
    expect(onCheck).toHaveBeenCalledOnce();

    documentTarget.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(0);
    await flushSchedulerPromises();
    expect(onCheck).toHaveBeenCalledTimes(2);
    expect(onCheck).toHaveBeenLastCalledWith("retry");

    vi.advanceTimersByTime(1_999);
    expect(onCheck).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    await flushSchedulerPromises();
    expect(onCheck).toHaveBeenCalledTimes(3);
    expect(onCheck).toHaveBeenLastCalledWith("interval");
    scheduler.stop();
  });

  it("waits for connectivity before releasing an overdue retry", async () => {
    const onCheck = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const scheduler = new AppUpdaterScheduler({
      startupDelayMs: 0,
      intervalMs: 60_000,
      foregroundDebounceMs: 100,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 4_000,
      random: () => 0.5,
    });
    navigatorState.onLine = false;
    scheduler.start(onCheck);
    vi.advanceTimersByTime(0);
    await flushSchedulerPromises();
    expect(onCheck).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10_000);
    expect(onCheck).not.toHaveBeenCalled();

    navigatorState.onLine = true;
    window.dispatchEvent(new Event("online"));
    vi.advanceTimersByTime(0);
    await flushSchedulerPromises();
    expect(onCheck).toHaveBeenCalledOnce();
    expect(onCheck).toHaveBeenCalledWith("retry");
    scheduler.stop();
  });

  it("discards a late failure after the scheduler stops", async () => {
    let rejectCheck: ((error: Error) => void) | undefined;
    const onCheck = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCheck = reject;
        })
    );
    const scheduler = new AppUpdaterScheduler({
      startupDelayMs: 0,
      intervalMs: 2_000,
      foregroundDebounceMs: 100,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 4_000,
      random: () => 0.5,
    });
    scheduler.start(onCheck);
    vi.advanceTimersByTime(0);
    await flushSchedulerPromises();
    expect(onCheck).toHaveBeenCalledOnce();

    scheduler.stop();
    rejectCheck?.(new Error("late failure"));
    await flushSchedulerPromises();
    vi.advanceTimersByTime(10_000);

    expect(onCheck).toHaveBeenCalledOnce();
  });
});

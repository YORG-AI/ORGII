import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppUpdaterScheduler } from "./appUpdaterScheduler";

describe("AppUpdaterScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    vi.stubGlobal(
      "window",
      Object.assign(windowTarget, {
        clearInterval: globalThis.clearInterval,
        clearTimeout: globalThis.clearTimeout,
        setInterval: globalThis.setInterval,
        setTimeout: globalThis.setTimeout,
      })
    );
    vi.stubGlobal(
      "document",
      Object.assign(documentTarget, { visibilityState: "visible" })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("debounces focus and visibility events into one foreground check", () => {
    const onCheck = vi.fn();
    const scheduler = new AppUpdaterScheduler({
      startupDelayMs: 10_000,
      intervalMs: 20_000,
      foregroundDebounceMs: 500,
    });
    scheduler.start(onCheck);

    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(499);
    expect(onCheck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

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
    });
    scheduler.start(onCheck);
    scheduler.stop();

    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    vi.advanceTimersByTime(10_000);

    expect(onCheck).not.toHaveBeenCalled();
  });

  it("can start active-use scheduling without a startup install", () => {
    const onCheck = vi.fn();
    const scheduler = new AppUpdaterScheduler({
      startupDelayMs: null,
      intervalMs: 2_000,
      foregroundDebounceMs: 100,
    });
    scheduler.start(onCheck);

    vi.advanceTimersByTime(1_999);
    expect(onCheck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onCheck).toHaveBeenCalledOnce();
    expect(onCheck).toHaveBeenCalledWith("interval");
    scheduler.stop();
  });
});

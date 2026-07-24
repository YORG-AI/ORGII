import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CountdownScheduler } from "./countdownScheduler";

describe("CountdownScheduler", () => {
  let documentTarget: EventTarget & { visibilityState: string };
  let now: number;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000;
    documentTarget = Object.assign(new EventTarget(), {
      visibilityState: "visible",
    });
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        clearTimeout: globalThis.clearTimeout,
        setTimeout: globalThis.setTimeout,
      })
    );
    vi.stubGlobal("document", documentTarget);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("updates at most once per second and stops at expiry", () => {
    const onUpdate = vi.fn();
    const scheduler = new CountdownScheduler(3_500, onUpdate, () => now);
    scheduler.start();

    expect(onUpdate).toHaveBeenLastCalledWith(2_500);
    now = 2_000;
    vi.advanceTimersByTime(1_000);
    expect(onUpdate).toHaveBeenLastCalledWith(1_500);
    now = 3_500;
    vi.advanceTimersByTime(1_000);
    expect(onUpdate).toHaveBeenLastCalledWith(0);

    vi.advanceTimersByTime(10_000);
    expect(onUpdate).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });

  it("pauses while hidden and recalculates once when visible", () => {
    const onUpdate = vi.fn();
    const scheduler = new CountdownScheduler(10_000, onUpdate, () => now);
    scheduler.start();

    documentTarget.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    now = 7_000;
    vi.advanceTimersByTime(10_000);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    documentTarget.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onUpdate).toHaveBeenLastCalledWith(3_000);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("removes timers and listeners on stop", () => {
    const onUpdate = vi.fn();
    const scheduler = new CountdownScheduler(10_000, onUpdate, () => now);
    scheduler.start();
    scheduler.stop();

    now = 5_000;
    vi.advanceTimersByTime(10_000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from "vitest";

import { createAnimationFrameScheduler } from "../animationFrameScheduler";

function createFrameHarness() {
  let nextFrameId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const requestFrame = vi.fn((callback: FrameRequestCallback) => {
    const frameId = nextFrameId++;
    callbacks.set(frameId, callback);
    return frameId;
  });
  const cancelFrame = vi.fn((frameId: number) => {
    callbacks.delete(frameId);
  });

  return {
    requestFrame,
    cancelFrame,
    flush(frameId: number) {
      const callback = callbacks.get(frameId);
      callbacks.delete(frameId);
      callback?.(0);
    },
  };
}

describe("createAnimationFrameScheduler", () => {
  it("coalesces repeated schedules into one frame", () => {
    const harness = createFrameHarness();
    const callback = vi.fn();
    const scheduler = createAnimationFrameScheduler(callback, harness);

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();

    expect(harness.requestFrame).toHaveBeenCalledTimes(1);
    harness.flush(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("allows a new frame after the pending frame runs", () => {
    const harness = createFrameHarness();
    const callback = vi.fn();
    const scheduler = createAnimationFrameScheduler(callback, harness);

    scheduler.schedule();
    harness.flush(1);
    scheduler.schedule();
    harness.flush(2);

    expect(callback).toHaveBeenCalledTimes(2);
    expect(harness.requestFrame).toHaveBeenCalledTimes(2);
  });

  it("cancels pending work and can schedule again", () => {
    const harness = createFrameHarness();
    const callback = vi.fn();
    const scheduler = createAnimationFrameScheduler(callback, harness);

    scheduler.schedule();
    scheduler.cancel();
    harness.flush(1);
    expect(callback).not.toHaveBeenCalled();
    expect(harness.cancelFrame).toHaveBeenCalledWith(1);

    scheduler.schedule();
    harness.flush(2);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

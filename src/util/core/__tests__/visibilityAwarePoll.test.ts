import { describe, expect, it, vi } from "vitest";

import {
  type PollEnvironment,
  startVisibilityAwarePoll,
} from "../visibilityAwarePoll";

function createEnvironment() {
  let visible = true;
  let visibilityListener: (() => void) | undefined;
  const environment: PollEnvironment = {
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    isVisible: () => visible,
    scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    subscribeToVisibilityChange: (callback) => {
      visibilityListener = callback;
      return () => {
        visibilityListener = undefined;
      };
    },
  };
  return {
    environment,
    setVisible(next: boolean) {
      visible = next;
      visibilityListener?.();
    },
  };
}

describe("startVisibilityAwarePoll", () => {
  it("waits for the active task before scheduling another pass", async () => {
    vi.useFakeTimers();
    const { environment } = createEnvironment();
    let release!: () => void;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const poll = startVisibilityAwarePoll({
      environment,
      intervalMs: 2_000,
      task,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(1);

    release();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(task).toHaveBeenCalledTimes(2);

    poll.stop();
    vi.useRealTimers();
  });

  it("drops its timer while hidden and catches up once on visibility", async () => {
    vi.useFakeTimers();
    const controlled = createEnvironment();
    const task = vi.fn().mockResolvedValue(undefined);
    const poll = startVisibilityAwarePoll({
      environment: controlled.environment,
      intervalMs: 2_000,
      task,
    });

    controlled.setVisible(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).not.toHaveBeenCalled();

    controlled.setVisible(true);
    await vi.runAllTicks();
    expect(task).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(task).toHaveBeenCalledTimes(2);

    poll.stop();
    vi.useRealTimers();
  });

  it("does not reschedule after stop while a task is settling", async () => {
    vi.useFakeTimers();
    const { environment } = createEnvironment();
    let release!: () => void;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const poll = startVisibilityAwarePoll({
      environment,
      intervalMs: 2_000,
      runImmediately: true,
      task,
    });

    expect(task).toHaveBeenCalledTimes(1);
    poll.stop();
    release();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

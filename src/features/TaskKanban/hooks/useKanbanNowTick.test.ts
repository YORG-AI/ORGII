import { afterEach, describe, expect, it, vi } from "vitest";

import { startKanbanNowClock } from "./useKanbanNowTick";

class VisibilitySourceStub {
  visibilityState: DocumentVisibilityState = "visible";
  private listener: (() => void) | undefined;

  addEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listener = listener;
  }

  removeEventListener(_type: "visibilitychange", listener: () => void): void {
    if (this.listener === listener) this.listener = undefined;
  }

  setVisibility(visibilityState: DocumentVisibilityState): void {
    this.visibilityState = visibilityState;
    this.listener?.();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startKanbanNowClock", () => {
  it("pauses hidden, refreshes on return, and disposes its only timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:00:00Z"));
    const source = new VisibilitySourceStub();
    const onTick = vi.fn();
    const stop = startKanbanNowClock(source, onTick, 30_000);

    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    source.setVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(onTick).toHaveBeenCalledTimes(1);

    source.setVisibility("visible");
    expect(onTick).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    stop();
    expect(vi.getTimerCount()).toBe(0);
    source.setVisibility("visible");
    expect(onTick).toHaveBeenCalledTimes(2);
  });
});

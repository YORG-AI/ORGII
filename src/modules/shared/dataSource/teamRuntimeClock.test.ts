import { afterEach, describe, expect, it, vi } from "vitest";

import { currentMinute, startTeamRuntimeClock } from "./teamRuntimeClock";

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

describe("startTeamRuntimeClock", () => {
  it("aligns ticks to minutes, pauses hidden, and disposes its timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:42.000Z"));
    const source = new VisibilitySourceStub();
    const onTick = vi.fn();
    const stop = startTeamRuntimeClock(source, onTick);

    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(17_999);
    expect(onTick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTick).toHaveBeenLastCalledWith(
      new Date("2026-08-23T10:01:00.000Z").getTime()
    );
    expect(vi.getTimerCount()).toBe(1);

    source.setVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5 * 60_000);
    expect(onTick).toHaveBeenCalledOnce();

    source.setVisibility("visible");
    expect(onTick).toHaveBeenCalledTimes(2);
    expect(onTick).toHaveBeenLastCalledWith(currentMinute());
    expect(vi.getTimerCount()).toBe(1);

    stop();
    expect(vi.getTimerCount()).toBe(0);
    source.setVisibility("visible");
    expect(onTick).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startVisibilityAwarePoller } from "./visibilityAwarePoller";

class VisibilitySource {
  visibilityState: DocumentVisibilityState;
  focused = true;
  private readonly listeners = new Set<() => void>();

  constructor(visibilityState: DocumentVisibilityState) {
    this.visibilityState = visibilityState;
  }

  addEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners.delete(listener);
  }

  hasFocus(): boolean {
    return this.focused;
  }

  setVisibility(visibilityState: DocumentVisibilityState): void {
    this.visibilityState = visibilityState;
    for (const listener of this.listeners) listener();
  }
}

class FocusSource {
  private readonly focusListeners = new Set<() => void>();
  private readonly blurListeners = new Set<() => void>();

  constructor(private readonly visibilitySource: VisibilitySource) {}

  addEventListener(type: "focus" | "blur", listener: () => void): void {
    (type === "focus" ? this.focusListeners : this.blurListeners).add(listener);
  }

  removeEventListener(type: "focus" | "blur", listener: () => void): void {
    (type === "focus" ? this.focusListeners : this.blurListeners).delete(
      listener
    );
  }

  setFocused(focused: boolean): void {
    this.visibilitySource.focused = focused;
    for (const listener of focused ? this.focusListeners : this.blurListeners) {
      listener();
    }
  }
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("startVisibilityAwarePoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does no hidden work and refreshes immediately when visible", async () => {
    const source = new VisibilitySource("hidden");
    const poll = vi.fn(() => Promise.resolve());
    const stop = startVisibilityAwarePoller(source, poll, 1_000);

    expect(poll).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    source.setVisibility("visible");
    expect(poll).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(poll).toHaveBeenCalledTimes(2);

    source.setVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(poll).toHaveBeenCalledTimes(2);

    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never overlaps requests and disposes without another timer", async () => {
    const source = new VisibilitySource("visible");
    const first = deferred();
    const second = deferred();
    const poll = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const stop = startVisibilityAwarePoller(source, poll, 1_000);

    expect(poll).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).toHaveBeenCalledTimes(1);

    source.setVisibility("hidden");
    source.setVisibility("visible");
    expect(poll).toHaveBeenCalledTimes(1);

    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(2);

    stop();
    second.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("does no unfocused work and refreshes once when focus returns", async () => {
    const source = new VisibilitySource("visible");
    const focusSource = new FocusSource(source);
    const poll = vi.fn(() => Promise.resolve());
    const stop = startVisibilityAwarePoller(source, poll, 1_000, {
      pauseWhenUnfocused: true,
      focusSource,
    });

    expect(poll).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);

    focusSource.setFocused(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(poll).toHaveBeenCalledTimes(1);

    focusSource.setFocused(true);
    expect(poll).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);

    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

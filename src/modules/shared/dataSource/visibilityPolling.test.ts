import { afterEach, describe, expect, it, vi } from "vitest";

import { startVisibilityAwarePolling } from "./visibilityPolling";

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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("startVisibilityAwarePolling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pauses while hidden, catches up on return, and stops cleanly", async () => {
    vi.useFakeTimers();
    const source = new VisibilitySourceStub();
    const poll = vi.fn().mockResolvedValue(undefined);
    const stop = startVisibilityAwarePolling(source, poll, 2_000);

    expect(vi.getTimerCount()).toBe(1);
    source.setVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).not.toHaveBeenCalled();

    source.setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    stop();
    expect(vi.getTimerCount()).toBe(0);
    source.setVisibility("visible");
    expect(poll).toHaveBeenCalledOnce();
  });

  it("does not overlap polls or rearm after disposal", async () => {
    vi.useFakeTimers();
    const source = new VisibilitySourceStub();
    const active = deferred();
    const poll = vi.fn().mockReturnValue(active.promise);
    const stop = startVisibilityAwarePolling(source, poll, 2_000);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(poll).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).toHaveBeenCalledOnce();

    stop();
    active.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

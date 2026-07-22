import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startVisibilityAwarePoller } from "./visibilityAwarePoller";

class VisibilitySource {
  visibilityState: DocumentVisibilityState;
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

  setVisibility(visibilityState: DocumentVisibilityState): void {
    this.visibilityState = visibilityState;
    for (const listener of this.listeners) listener();
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

    source.setVisibility("visible");
    expect(poll).toHaveBeenCalledTimes(1);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(poll).toHaveBeenCalledTimes(2);

    source.setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(poll).toHaveBeenCalledTimes(2);

    stop();
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
});

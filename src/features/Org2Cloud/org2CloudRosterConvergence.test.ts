// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startOrg2CloudRosterConvergence } from "./org2CloudRosterConvergence";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("org2 cloud roster convergence", () => {
  let visibilityState: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers();
    visibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibilityState
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("refreshes on the slow timer and focus without overlapping requests", async () => {
    const first = deferred();
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const stop = startOrg2CloudRosterConvergence({
      refresh,
      intervalMs: 1_000,
    });

    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    first.resolve();
    await first.promise;
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);

    stop();
  });

  it("cools down focus flaps while the timer cadence still converges", async () => {
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const stop = startOrg2CloudRosterConvergence({
      refresh,
      intervalMs: 10_000,
      focusCooldownMs: 5_000,
    });

    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(1_000);
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_500);
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);

    stop();
  });

  it("pauses while hidden, catches up once visible, and disposes cleanly", async () => {
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const stop = startOrg2CloudRosterConvergence({
      refresh,
      intervalMs: 1_000,
    });

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refresh).not.toHaveBeenCalled();

    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    stop();
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

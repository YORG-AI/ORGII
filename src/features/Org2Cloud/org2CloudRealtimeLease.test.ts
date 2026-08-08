import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  REALTIME_LEASE_RELEASE_GRACE_MS,
  createOrg2CloudLeaseMinimizeBridge,
  createOrg2CloudRealtimeLeaseController,
} from "./org2CloudRealtimeLease";

describe("Org2Cloud Realtime connection lease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(initialForeground = true) {
    let foreground = initialForeground;
    let hidden = false;
    const transitions: boolean[] = [];
    const controller = createOrg2CloudRealtimeLeaseController({
      isForeground: () => foreground,
      isHidden: () => hidden,
      onChange: (held) => transitions.push(held),
    });
    return {
      controller,
      transitions,
      setForeground(next: boolean) {
        foreground = next;
        controller.refresh();
      },
      setHidden(next: boolean) {
        hidden = next;
        if (next) foreground = false;
        controller.refresh();
      },
    };
  }

  it("keeps the lease through the grace window on blur alone", () => {
    const { controller, transitions, setForeground } = setup();

    setForeground(false);
    vi.advanceTimersByTime(REALTIME_LEASE_RELEASE_GRACE_MS - 1);

    expect(controller.isHeld()).toBe(true);
    expect(transitions).toEqual([]);
  });

  it("releases after the grace window elapses while blurred", () => {
    const { controller, transitions, setForeground } = setup();

    setForeground(false);
    vi.advanceTimersByTime(REALTIME_LEASE_RELEASE_GRACE_MS);

    expect(controller.isHeld()).toBe(false);
    expect(transitions).toEqual([false]);
  });

  it("cancels the pending release when focus returns within the grace window", () => {
    const { controller, transitions, setForeground } = setup();

    setForeground(false);
    vi.advanceTimersByTime(REALTIME_LEASE_RELEASE_GRACE_MS - 1);
    setForeground(true);
    vi.advanceTimersByTime(REALTIME_LEASE_RELEASE_GRACE_MS * 2);

    expect(controller.isHeld()).toBe(true);
    expect(transitions).toEqual([]);
  });

  it("releases immediately when the document becomes hidden", () => {
    const { controller, transitions, setHidden } = setup();

    setHidden(true);

    expect(controller.isHeld()).toBe(false);
    expect(transitions).toEqual([false]);
  });

  it("deduplicates repeated blur refreshes into a single pending release", () => {
    const { controller, transitions, setForeground } = setup();

    setForeground(false);
    controller.refresh();
    controller.refresh();
    vi.advanceTimersByTime(REALTIME_LEASE_RELEASE_GRACE_MS);

    expect(controller.isHeld()).toBe(false);
    expect(transitions).toEqual([false]);
  });

  it("reacquires immediately when focus returns after a release", () => {
    const { controller, transitions, setForeground } = setup();

    setForeground(false);
    vi.advanceTimersByTime(REALTIME_LEASE_RELEASE_GRACE_MS);
    setForeground(true);

    expect(controller.isHeld()).toBe(true);
    expect(transitions).toEqual([false, true]);
  });

  it("releases immediately on pagehide, cancelling any pending grace timer", () => {
    const { controller, transitions, setForeground } = setup();

    setForeground(false);
    controller.releaseImmediately();
    vi.advanceTimersByTime(REALTIME_LEASE_RELEASE_GRACE_MS * 2);

    expect(controller.isHeld()).toBe(false);
    expect(transitions).toEqual([false]);
  });

  it("does not publish after disposal, even from a pending grace timer", () => {
    const { controller, transitions, setForeground } = setup();

    setForeground(false);
    controller.dispose();
    vi.advanceTimersByTime(REALTIME_LEASE_RELEASE_GRACE_MS * 2);

    expect(controller.isHeld()).toBe(true);
    expect(transitions).toEqual([]);
  });
});

describe("minimize bridge (Windows minimize never reports visibility hidden)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function deferredBoolean() {
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("flips to minimized when the probe resolves true and notifies once", async () => {
    const reads: Array<ReturnType<typeof deferredBoolean>> = [];
    const changes: boolean[] = [];
    const bridge = createOrg2CloudLeaseMinimizeBridge(
      () => {
        const d = deferredBoolean();
        reads.push(d);
        return d.promise;
      },
      () => changes.push(bridge.isMinimized())
    );

    bridge.probe();
    expect(bridge.isMinimized()).toBe(false);
    reads[0].resolve(true);
    await reads[0].promise;

    expect(bridge.isMinimized()).toBe(true);
    expect(changes).toEqual([true]);
  });

  it("releases the blurred lease immediately once the probe reports minimized", async () => {
    let foreground = true;
    const read = deferredBoolean();
    const transitions: boolean[] = [];
    const bridge = createOrg2CloudLeaseMinimizeBridge(
      () => read.promise,
      () => controller.refresh()
    );
    const controller = createOrg2CloudRealtimeLeaseController({
      isForeground: () => foreground,
      isHidden: () => bridge.isMinimized(),
      onChange: (held) => transitions.push(held),
    });

    // Windows minimize: blur fires, visibility stays "visible".
    foreground = false;
    controller.refresh();
    bridge.probe();
    expect(controller.isHeld()).toBe(true);

    read.resolve(true);
    await read.promise;

    // No grace wait: the probe resolution released the lease directly.
    expect(controller.isHeld()).toBe(false);
    expect(transitions).toEqual([false]);
  });

  it("clearOnFocus resets synchronously and drops stale probe results", async () => {
    const first = deferredBoolean();
    const changes: boolean[] = [];
    const bridge = createOrg2CloudLeaseMinimizeBridge(
      () => first.promise,
      () => changes.push(bridge.isMinimized())
    );

    bridge.probe();
    // Rapid minimize→restore: focus arrives before the probe resolves.
    bridge.clearOnFocus();
    first.resolve(true);
    await first.promise;

    // The stale `true` must not resurface after focus invalidated it.
    expect(bridge.isMinimized()).toBe(false);
    expect(changes).toEqual([]);
  });

  it("clearOnFocus notifies only when a minimized belief is actually reset", async () => {
    const read = deferredBoolean();
    const changes: boolean[] = [];
    const bridge = createOrg2CloudLeaseMinimizeBridge(
      () => read.promise,
      () => changes.push(bridge.isMinimized())
    );

    bridge.clearOnFocus();
    expect(changes).toEqual([]);

    bridge.probe();
    read.resolve(true);
    await read.promise;
    bridge.clearOnFocus();

    expect(bridge.isMinimized()).toBe(false);
    expect(changes).toEqual([true, false]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  REALTIME_LEASE_RELEASE_GRACE_MS,
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

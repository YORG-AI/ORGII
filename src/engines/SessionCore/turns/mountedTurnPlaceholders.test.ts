import { describe, expect, it } from "vitest";

import {
  clearMountedTurnPlaceholders,
  getMountedTurnPlaceholderIds,
  registerMountedTurnPlaceholder,
  unregisterMountedTurnPlaceholder,
} from "./mountedTurnPlaceholders";

describe("mountedTurnPlaceholders registry", () => {
  it("returns an empty set for a session with no registrations", () => {
    expect(getMountedTurnPlaceholderIds("session-never-seen").size).toBe(0);
  });

  it("tracks a registered turn id until it is unregistered", () => {
    clearMountedTurnPlaceholders("session-a");

    registerMountedTurnPlaceholder("session-a", "turn-1");
    expect(getMountedTurnPlaceholderIds("session-a")).toEqual(
      new Set(["turn-1"])
    );

    unregisterMountedTurnPlaceholder("session-a", "turn-1");
    expect(getMountedTurnPlaceholderIds("session-a").size).toBe(0);
  });

  it("tracks many concurrently-mounted placeholders for the same session", () => {
    clearMountedTurnPlaceholders("session-a");

    registerMountedTurnPlaceholder("session-a", "turn-1");
    registerMountedTurnPlaceholder("session-a", "turn-2");
    registerMountedTurnPlaceholder("session-a", "turn-3");

    expect(getMountedTurnPlaceholderIds("session-a")).toEqual(
      new Set(["turn-1", "turn-2", "turn-3"])
    );

    unregisterMountedTurnPlaceholder("session-a", "turn-2");
    expect(getMountedTurnPlaceholderIds("session-a")).toEqual(
      new Set(["turn-1", "turn-3"])
    );
  });

  it("is idempotent: registering the same turn id twice does not duplicate it", () => {
    clearMountedTurnPlaceholders("session-a");

    registerMountedTurnPlaceholder("session-a", "turn-1");
    registerMountedTurnPlaceholder("session-a", "turn-1");

    expect(getMountedTurnPlaceholderIds("session-a").size).toBe(1);
  });

  it("unregistering an id that was never registered is a no-op", () => {
    clearMountedTurnPlaceholders("session-a");

    expect(() =>
      unregisterMountedTurnPlaceholder("session-a", "turn-404")
    ).not.toThrow();
    expect(getMountedTurnPlaceholderIds("session-a").size).toBe(0);
  });

  it("unregistering from an unknown session is a no-op", () => {
    expect(() =>
      unregisterMountedTurnPlaceholder("session-unknown", "turn-1")
    ).not.toThrow();
  });

  it("isolates registrations per session", () => {
    clearMountedTurnPlaceholders("session-a");
    clearMountedTurnPlaceholders("session-b");

    registerMountedTurnPlaceholder("session-a", "turn-1");
    registerMountedTurnPlaceholder("session-b", "turn-1");

    unregisterMountedTurnPlaceholder("session-a", "turn-1");

    expect(getMountedTurnPlaceholderIds("session-a").size).toBe(0);
    expect(getMountedTurnPlaceholderIds("session-b")).toEqual(
      new Set(["turn-1"])
    );
  });

  it("drops the session's entry entirely once the last id unregisters", () => {
    clearMountedTurnPlaceholders("session-a");

    registerMountedTurnPlaceholder("session-a", "turn-1");
    unregisterMountedTurnPlaceholder("session-a", "turn-1");

    // Returned set is the shared empty-set singleton, not a lingering
    // session-scoped Set instance — asserting size is the externally
    // observable contract (internal Map cleanup is an implementation
    // detail this test doesn't otherwise need to reach into).
    expect(getMountedTurnPlaceholderIds("session-a").size).toBe(0);
  });
});

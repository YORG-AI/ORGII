import { describe, expect, it } from "vitest";

import {
  shouldMountAgentStationHost,
  shouldMountBrowserHost,
  shouldMountWorkstationHost,
} from "./hostMountPolicy";

describe("shouldMountWorkstationHost", () => {
  it("unmounts everything on the empty Launchpad, even previously visited hosts", () => {
    expect(
      shouldMountWorkstationHost({
        hasRealTabs: false,
        isActiveHost: true,
        hasVisited: true,
      })
    ).toBe(false);
  });

  it("mounts the host that owns the active tab", () => {
    expect(
      shouldMountWorkstationHost({
        hasRealTabs: true,
        isActiveHost: true,
        hasVisited: false,
      })
    ).toBe(true);
  });

  it("keeps a visited host warm while real tabs remain", () => {
    expect(
      shouldMountWorkstationHost({
        hasRealTabs: true,
        isActiveHost: false,
        hasVisited: true,
      })
    ).toBe(true);
  });

  it("does not mount an unvisited, inactive host", () => {
    expect(
      shouldMountWorkstationHost({
        hasRealTabs: true,
        isActiveHost: false,
        hasVisited: false,
      })
    ).toBe(false);
  });
});

describe("shouldMountBrowserHost", () => {
  const idle = {
    hasRealTabs: false,
    isActiveHost: false,
    hasVisited: false,
    hasBrowserHostTabs: false,
    hasBrowserSessions: false,
    hasPendingNewSessionRequest: false,
  };

  it("stays unmounted on the empty Launchpad with no sessions or requests", () => {
    expect(shouldMountBrowserHost(idle)).toBe(false);
  });

  it("mounts for a pending New Browser request even with no tabs (Launchpad flow)", () => {
    expect(
      shouldMountBrowserHost({ ...idle, hasPendingNewSessionRequest: true })
    ).toBe(true);
  });

  it("stays mounted while engine sessions exist, bridging request → tab sync", () => {
    // After the consumed-tick effect fires, the request is no longer pending
    // but the browser-session tab has not been created yet — the session
    // itself must hold the host mounted through that gap.
    expect(shouldMountBrowserHost({ ...idle, hasBrowserSessions: true })).toBe(
      true
    );
  });

  it("mounts for background browser-session tabs before first activation", () => {
    expect(
      shouldMountBrowserHost({
        ...idle,
        hasRealTabs: true,
        hasBrowserHostTabs: true,
      })
    ).toBe(true);
  });

  it("follows the shared keep-alive policy otherwise", () => {
    expect(
      shouldMountBrowserHost({ ...idle, hasRealTabs: true, hasVisited: true })
    ).toBe(true);
    expect(shouldMountBrowserHost({ ...idle, hasRealTabs: true })).toBe(false);
  });
});

describe("shouldMountAgentStationHost", () => {
  it("always mounts while Agent Station is the visible surface", () => {
    expect(
      shouldMountAgentStationHost({
        isAgentStation: true,
        hasVisited: false,
        hasActiveSession: false,
      })
    ).toBe(true);
  });

  it("keeps the hidden simulator warm only while a session is attached", () => {
    expect(
      shouldMountAgentStationHost({
        isAgentStation: false,
        hasVisited: true,
        hasActiveSession: true,
      })
    ).toBe(true);
    expect(
      shouldMountAgentStationHost({
        isAgentStation: false,
        hasVisited: true,
        hasActiveSession: false,
      })
    ).toBe(false);
  });

  it("never mounts an unvisited, hidden simulator", () => {
    expect(
      shouldMountAgentStationHost({
        isAgentStation: false,
        hasVisited: false,
        hasActiveSession: true,
      })
    ).toBe(false);
  });
});

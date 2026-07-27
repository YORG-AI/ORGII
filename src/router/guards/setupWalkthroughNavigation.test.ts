import { describe, expect, it } from "vitest";

import { resolveSetupWalkthroughNavigation } from "./setupWalkthroughNavigation";

describe("first-use setup navigation", () => {
  it("waits for persisted state before routing a primary app window", () => {
    expect(
      resolveSetupWalkthroughNavigation({
        loaded: false,
        outcome: "open",
        pathname: "/orgii/workstation/code",
      })
    ).toBe("wait");
  });

  it("redirects an open primary app window to onboarding", () => {
    expect(
      resolveSetupWalkthroughNavigation({
        loaded: true,
        outcome: "open",
        pathname: "/orgii/workstation/code",
      })
    ).toBe("redirect-to-setup");
  });

  it("allows the open onboarding route and closes it after any terminal outcome", () => {
    expect(
      resolveSetupWalkthroughNavigation({
        loaded: true,
        outcome: "open",
        pathname: "/orgii/app/walkthrough",
      })
    ).toBe("continue");

    for (const outcome of ["completed", "dismissed"] as const) {
      expect(
        resolveSetupWalkthroughNavigation({
          loaded: true,
          outcome,
          pathname: "/orgii/app/walkthrough",
        })
      ).toBe("redirect-to-workstation");
    }
  });

  it("does not intercept root, login, callback, or secondary windows", () => {
    for (const pathname of [
      "/",
      "/orgii/app/login",
      "/orgii/marketplace/callback",
      "/orgii/windows/tab/123",
    ]) {
      expect(
        resolveSetupWalkthroughNavigation({
          loaded: true,
          outcome: "open",
          pathname,
        })
      ).toBe("continue");
    }
  });
});

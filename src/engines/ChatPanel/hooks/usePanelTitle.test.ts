import { describe, expect, it } from "vitest";

import { resolvePanelTitle } from "./usePanelTitle";

describe("resolvePanelTitle", () => {
  it("keeps the session tab title while the session is loading", () => {
    expect(
      resolvePanelTitle({
        currentSessionId: "session-1",
        currentSession: null,
        activeTabTitle: "Fix loading header title",
        defaultTitle: "Session",
        newSessionTitle: "New session",
      })
    ).toBe("Fix loading header title");
  });

  it("uses the generic title when a loading tab has no usable title", () => {
    expect(
      resolvePanelTitle({
        currentSessionId: "session-1",
        currentSession: null,
        activeTabTitle: "  ",
        defaultTitle: "Session",
        newSessionTitle: "New session",
      })
    ).toBe("Session");
  });
});

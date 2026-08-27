import { describe, expect, it } from "vitest";

import { resolveComposerSectionForSessionSwitch } from "../composerSectionState";

describe("resolveComposerSectionForSessionSwitch", () => {
  it("auto-expands queued messages when returning to a session with no stored section preference", () => {
    expect(
      resolveComposerSectionForSessionSwitch({
        previousSessionId: "session-b",
        nextSessionId: "session-a",
        currentActiveSection: null,
        queueCount: 2,
      }).activeSection
    ).toBe("queue");
  });

  it("preserves an explicit collapsed queue section for that session", () => {
    expect(
      resolveComposerSectionForSessionSwitch({
        previousSessionId: "session-b",
        nextSessionId: "session-a",
        currentActiveSection: "process",
        queueCount: 2,
        previouslyStoredSection: null,
      }).activeSection
    ).toBeNull();
  });

  it("stores the previous session section before switching away", () => {
    expect(
      resolveComposerSectionForSessionSwitch({
        previousSessionId: "session-a",
        nextSessionId: "session-b",
        currentActiveSection: "queue",
        queueCount: 0,
      }).storedSectionForPrevious
    ).toBe("queue");
  });
});

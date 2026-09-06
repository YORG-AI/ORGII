import { describe, expect, it } from "vitest";

import { shouldShowInRecentTabsMenu } from "./recentTabsMenu";

describe("shouldShowInRecentTabsMenu", () => {
  it.each(["file", "directory", "chat-session", "session"])(
    "keeps the specific %s context",
    (type) => {
      expect(shouldShowInRecentTabsMenu({ type })).toBe(true);
    }
  );

  it.each([
    "explorer",
    "terminal",
    "browser-session",
    "work-management",
    "runtime",
    "project-dashboard",
  ])("hides the %s destination already offered by the menu", (type) => {
    expect(shouldShowInRecentTabsMenu({ type })).toBe(false);
  });
});

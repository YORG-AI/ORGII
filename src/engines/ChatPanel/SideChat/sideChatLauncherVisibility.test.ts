import { describe, expect, it } from "vitest";

import type { ChatPanelTabType } from "@src/store/chatPanel/chatPanelTabsAtom";

import { shouldShowSideChatLauncher } from "./sideChatLauncherVisibility";

describe("shouldShowSideChatLauncher", () => {
  it("hides the launcher on surfaces that already own a composer", () => {
    expect(shouldShowSideChatLauncher("start-page")).toBe(false);
    expect(shouldShowSideChatLauncher("session")).toBe(false);
  });

  it("shows the launcher on chat-less work surfaces", () => {
    const surfaces: ChatPanelTabType[] = [
      "work-item",
      "work-management",
      "project",
      "runtime",
      "workspace",
      "organization",
      "github-issue",
      "github-pr",
      "explore",
      "channel",
      "run-group",
      "team-inbox",
      "terminal",
    ];

    for (const type of surfaces) {
      expect(shouldShowSideChatLauncher(type)).toBe(true);
    }
  });

  it("hides the launcher when no tab is active", () => {
    expect(shouldShowSideChatLauncher(null)).toBe(false);
    expect(shouldShowSideChatLauncher(undefined)).toBe(false);
  });
});

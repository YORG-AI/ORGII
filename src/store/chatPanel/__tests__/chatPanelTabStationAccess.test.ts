import { describe, expect, it } from "vitest";

import {
  type ChatPanelTabType,
  isChatPanelTabStationAvailable,
  resolveChatPanelMaximizedForLayout,
} from "../chatPanelTabsAtom";

describe("Chat Panel tab Station access", () => {
  it.each<ChatPanelTabType>([
    "session",
    "terminal",
    "start-page",
    "channel",
    "run-group",
  ])("keeps Station access available for %s tabs", (type) => {
    expect(isChatPanelTabStationAvailable(type)).toBe(true);
  });

  it.each<ChatPanelTabType>([
    "runtime",
    "team-inbox",
    "work-management",
    "workspace",
    "organization",
    "work-item",
    "github-issue",
    "github-pr",
    "project",
    "explore",
  ])("never allows Station access for %s tabs", (type) => {
    expect(isChatPanelTabStationAvailable(type)).toBe(false);
  });

  it("forces the effective layout full-screen without changing the saved preference", () => {
    expect(resolveChatPanelMaximizedForLayout(false, "work-item")).toBe(true);
    expect(resolveChatPanelMaximizedForLayout(true, "work-item")).toBe(true);
    expect(resolveChatPanelMaximizedForLayout(false, "session")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  CHAT_PANEL_STATION_WIDE_VIEWPORT_MIN_PX,
  type ChatPanelTabType,
  isChatPanelTabStationAvailable,
  resolveChatPanelMaximizedForLayout,
} from "../chatPanelTabsAtom";

describe("Chat Panel tab Station access", () => {
  it("uses 1920px as the wide Station breakpoint", () => {
    expect(CHAT_PANEL_STATION_WIDE_VIEWPORT_MIN_PX).toBe(1920);
  });

  it.each<ChatPanelTabType>(["session", "terminal", "start-page", "channel"])(
    "keeps Station access available for %s tabs at every viewport width",
    (type) => {
      expect(isChatPanelTabStationAvailable(type, 800)).toBe(true);
      expect(isChatPanelTabStationAvailable(type, 2000)).toBe(true);
    }
  );

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
  ])("unlocks %s tabs only on a wide viewport", (type) => {
    expect(
      isChatPanelTabStationAvailable(
        type,
        CHAT_PANEL_STATION_WIDE_VIEWPORT_MIN_PX - 1
      )
    ).toBe(false);
    expect(
      isChatPanelTabStationAvailable(
        type,
        CHAT_PANEL_STATION_WIDE_VIEWPORT_MIN_PX
      )
    ).toBe(true);
  });

  it("forces the effective layout full-screen without changing the saved preference", () => {
    expect(resolveChatPanelMaximizedForLayout(false, "work-item", 1200)).toBe(
      true
    );
    expect(
      resolveChatPanelMaximizedForLayout(
        false,
        "work-item",
        CHAT_PANEL_STATION_WIDE_VIEWPORT_MIN_PX
      )
    ).toBe(false);
    expect(
      resolveChatPanelMaximizedForLayout(
        true,
        "work-item",
        CHAT_PANEL_STATION_WIDE_VIEWPORT_MIN_PX
      )
    ).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import {
  FOCUSED_CHAT_WORKSTATION_MINIMAP_HOST_CLASS,
  resolveFocusedChatWorkstationRailInsetStyle,
  resolveFocusedChatWorkstationRailTrackClass,
  resolveFocusedChatWorkstationSectionOrder,
  shouldMountFocusedChatWorkstationControls,
  shouldReserveFocusedChatWorkstationPlaceholder,
} from "./focusedChatWorkstationLayout";
import { CHAT_PANEL_HEADER_STACK_HEIGHT_PX } from "./header/chatPanelHeaderLayout";

describe("shouldMountFocusedChatWorkstationControls", () => {
  it("mounts only for a maximized session with visible session content", () => {
    expect(
      shouldMountFocusedChatWorkstationControls({
        activeTabType: "session",
        isChatFocus: true,
        showSessionContent: true,
      })
    ).toBe(true);
  });

  it.each([
    {
      activeTabType: "session" as const,
      isChatFocus: false,
      showSessionContent: true,
    },
    {
      activeTabType: "project" as const,
      isChatFocus: true,
      showSessionContent: true,
    },
    {
      activeTabType: "session" as const,
      isChatFocus: true,
      showSessionContent: false,
    },
  ])("stays unmounted outside the focused session lifecycle", (input) => {
    expect(shouldMountFocusedChatWorkstationControls(input)).toBe(false);
  });
});

describe("shouldReserveFocusedChatWorkstationPlaceholder", () => {
  it("reserves the collapsed rail track for a focused visible Launchpad", () => {
    expect(
      shouldReserveFocusedChatWorkstationPlaceholder({
        activeTabType: "start-page",
        isChatFocus: true,
        startPageOpen: true,
      })
    ).toBe(true);
  });

  it.each([
    {
      activeTabType: "start-page" as const,
      isChatFocus: false,
      startPageOpen: true,
    },
    {
      activeTabType: "start-page" as const,
      isChatFocus: true,
      startPageOpen: false,
    },
    {
      activeTabType: "session" as const,
      isChatFocus: true,
      startPageOpen: true,
    },
  ])("does not reserve the track outside Launchpad focus", (input) => {
    expect(shouldReserveFocusedChatWorkstationPlaceholder(input)).toBe(false);
  });
});

describe("resolveFocusedChatWorkstationRailTrackClass", () => {
  it("uses fixed expanded and collapsed tracks without resize geometry", () => {
    expect(resolveFocusedChatWorkstationRailTrackClass(false)).toBe(
      "w-0 @[1100px]/focusedchat:w-64 @[1100px]/focusedchat:px-1 @[1100px]/focusedchat:pb-1 @[1100px]/focusedchat:pt-2"
    );
    expect(resolveFocusedChatWorkstationRailTrackClass(true)).toBe(
      "w-0 @[1100px]/focusedchat:w-11 @[1100px]/focusedchat:px-1 @[1100px]/focusedchat:pb-1 @[1100px]/focusedchat:pt-2"
    );
  });
});

describe("resolveFocusedChatWorkstationRailInsetStyle", () => {
  it("restores the rail below the overlaid two-row chat header", () => {
    expect(
      resolveFocusedChatWorkstationRailInsetStyle(
        CHAT_PANEL_HEADER_STACK_HEIGHT_PX
      )
    ).toEqual({
      marginTop: "84px",
      height: "calc(100% - 84px)",
    });
  });

  it("does not alter non-overlay rail placement", () => {
    expect(resolveFocusedChatWorkstationRailInsetStyle(0)).toEqual({});
  });
});

describe("FOCUSED_CHAT_WORKSTATION_MINIMAP_HOST_CLASS", () => {
  it("stays centered on the fixed trailing rail column when expanded", () => {
    expect(FOCUSED_CHAT_WORKSTATION_MINIMAP_HOST_CLASS).toContain("w-9");
    expect(FOCUSED_CHAT_WORKSTATION_MINIMAP_HOST_CLASS).toContain(
      "@[1100px]/focusedchat:ml-auto"
    );
    expect(FOCUSED_CHAT_WORKSTATION_MINIMAP_HOST_CLASS).not.toContain(
      "@[1100px]/focusedchat:w-full"
    );
  });
});

describe("resolveFocusedChatWorkstationSectionOrder", () => {
  it("places open tabs below the environment section", () => {
    expect(resolveFocusedChatWorkstationSectionOrder(true)).toEqual([
      "workspace",
      "tabs",
    ]);
    expect(resolveFocusedChatWorkstationSectionOrder(false)).toEqual([
      "workspace",
    ]);
  });
});

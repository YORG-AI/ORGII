import { describe, expect, it } from "vitest";

import {
  FOCUSED_CHAT_MINIMAP_COLUMN_CONTAINER_PX,
  FOCUSED_CHAT_WORKSTATION_MINIMAP_HOST_CLASS,
  isSameFocusedChatGitEnvironment,
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
  it("drives the expanded column from the resizable track-width variable", () => {
    expect(resolveFocusedChatWorkstationRailTrackClass(false)).toBe(
      "w-0 @[850px]/focusedchat:w-9 @[1100px]/focusedchat:w-[var(--workstation-trail-track-width)] @[1100px]/focusedchat:px-1 @[1100px]/focusedchat:pb-1 @[1100px]/focusedchat:pt-2"
    );
  });

  it("keeps the collapsed track at the fixed button-controlled width", () => {
    expect(resolveFocusedChatWorkstationRailTrackClass(true)).toBe(
      "w-0 @[850px]/focusedchat:w-9 @[1100px]/focusedchat:w-11 @[1100px]/focusedchat:px-1 @[1100px]/focusedchat:pb-1 @[1100px]/focusedchat:pt-2"
    );
  });

  it("reserves the minimap rail's column only once the pane can spare it", () => {
    // Under 850px a maximized pane is as tight as a side pane: the column is
    // zero and the rail floats, rather than taking 36px off the transcript.
    for (const collapsed of [false, true]) {
      const track = resolveFocusedChatWorkstationRailTrackClass(collapsed);
      expect(track).toContain("w-0");
      expect(track).toContain(
        `@[${FOCUSED_CHAT_MINIMAP_COLUMN_CONTAINER_PX}px]/focusedchat:w-9`
      );
    }
  });
});

describe("resolveFocusedChatWorkstationRailInsetStyle", () => {
  it("restores the rail below the overlaid two-row chat header", () => {
    expect(
      resolveFocusedChatWorkstationRailInsetStyle(
        CHAT_PANEL_HEADER_STACK_HEIGHT_PX
      )
    ).toEqual({
      marginTop: `${CHAT_PANEL_HEADER_STACK_HEIGHT_PX}px`,
      height: `calc(100% - ${CHAT_PANEL_HEADER_STACK_HEIGHT_PX}px)`,
    });
  });

  it("does not alter non-overlay rail placement", () => {
    expect(resolveFocusedChatWorkstationRailInsetStyle(0)).toEqual({});
  });
});

describe("FOCUSED_CHAT_WORKSTATION_MINIMAP_HOST_CLASS", () => {
  it("floats over the transcript while the pane is too tight for a column", () => {
    // Pinned flush at the pane edge and 36px wide — the same box the side
    // pane's rail floats in, so the pill's own `right-3` lands on the
    // identical spot in both panes.
    expect(FOCUSED_CHAT_WORKSTATION_MINIMAP_HOST_CLASS).toContain("absolute");
    expect(FOCUSED_CHAT_WORKSTATION_MINIMAP_HOST_CLASS).toContain("right-0");
    expect(FOCUSED_CHAT_WORKSTATION_MINIMAP_HOST_CLASS).toContain("w-9");
  });

  it("joins the flow at the width where the track reserves its column", () => {
    expect(FOCUSED_CHAT_WORKSTATION_MINIMAP_HOST_CLASS).toContain(
      `@[${FOCUSED_CHAT_MINIMAP_COLUMN_CONTAINER_PX}px]/focusedchat:relative`
    );
  });

  it("stays centered on the fixed trailing rail column when expanded", () => {
    expect(FOCUSED_CHAT_WORKSTATION_MINIMAP_HOST_CLASS).toContain("w-9");
    expect(FOCUSED_CHAT_WORKSTATION_MINIMAP_HOST_CLASS).toContain(
      `@[${FOCUSED_CHAT_MINIMAP_COLUMN_CONTAINER_PX}px]/focusedchat:ml-auto`
    );
    expect(FOCUSED_CHAT_WORKSTATION_MINIMAP_HOST_CLASS).not.toContain("w-full");
  });
});

describe("resolveFocusedChatWorkstationSectionOrder", () => {
  it("places the local environment above the session environment and open tabs", () => {
    expect(resolveFocusedChatWorkstationSectionOrder(true, true)).toEqual([
      "workspace",
      "session",
      "tabs",
    ]);
    expect(resolveFocusedChatWorkstationSectionOrder(false, true)).toEqual([
      "workspace",
      "session",
    ]);
  });

  it("omits an empty session environment without hiding local actions", () => {
    expect(resolveFocusedChatWorkstationSectionOrder(true, false)).toEqual([
      "workspace",
      "tabs",
    ]);
  });

  it("slots subagents below the environment sections and above open tabs", () => {
    expect(resolveFocusedChatWorkstationSectionOrder(true, true, true)).toEqual(
      ["workspace", "session", "subagents", "tabs"]
    );
    expect(
      resolveFocusedChatWorkstationSectionOrder(false, false, true)
    ).toEqual(["workspace", "subagents"]);
  });
});

describe("isSameFocusedChatGitEnvironment", () => {
  it("recognizes the same session and local Git identity", () => {
    expect(
      isSameFocusedChatGitEnvironment({
        localBranchName: "develop",
        localRepoPath: "/workspace/ORGII/",
        sessionBranchName: "develop",
        sessionRepoPath: "/workspace/ORGII",
      })
    ).toBe(true);
  });

  it("keeps different session branches on an independent PR lookup", () => {
    expect(
      isSameFocusedChatGitEnvironment({
        localBranchName: "develop",
        localRepoPath: "/workspace/ORGII",
        sessionBranchName: "feat/session",
        sessionRepoPath: "/workspace/ORGII",
      })
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  CHAT_PANEL_GLASS_SURFACE_CLASS,
  CHAT_PANEL_HEADER_STACK_HEIGHT_PX,
  CHAT_PANEL_TRANSCRIPT_TOP_GAP_PX,
  CHAT_PANEL_TRANSCRIPT_TOP_PADDING_PX,
  resolveTranscriptTopPaddingPx,
  shouldOverlayChatSessionHeaders,
} from "./chatPanelHeaderLayout";

describe("chat panel header overlay", () => {
  it("uses a dense glass fill so scrolled content stays subdued", () => {
    expect(CHAT_PANEL_GLASS_SURFACE_CLASS).toContain("bg-chat-pane/70");
    expect(CHAT_PANEL_GLASS_SURFACE_CLASS).toContain("backdrop-blur-xl");
  });

  it("floats the full header stack for every ordinary session view", () => {
    expect(
      shouldOverlayChatSessionHeaders({
        showSessionContent: true,
        standaloneToolTabActive: false,
        humanSessionActive: false,
      })
    ).toBe(true);
    expect(CHAT_PANEL_HEADER_STACK_HEIGHT_PX).toBe(84);
  });

  it.each([
    [false, false, false],
    [true, true, false],
    [true, false, true],
  ])(
    "keeps non-session and human-session headers in normal flow",
    (showSessionContent, standaloneToolTabActive, humanSessionActive) => {
      expect(
        shouldOverlayChatSessionHeaders({
          showSessionContent,
          standaloneToolTabActive,
          humanSessionActive,
        })
      ).toBe(false);
    }
  );
});

describe("transcript top padding under floating chrome", () => {
  it("moves the chrome share to the pinned host when it renders in flow", () => {
    expect(
      resolveTranscriptTopPaddingPx(CHAT_PANEL_HEADER_STACK_HEIGHT_PX, true)
    ).toBe(CHAT_PANEL_TRANSCRIPT_TOP_GAP_PX);
  });

  it("keeps the full padding when the transcript scrolls behind the chrome", () => {
    expect(
      resolveTranscriptTopPaddingPx(CHAT_PANEL_HEADER_STACK_HEIGHT_PX, false)
    ).toBe(CHAT_PANEL_TRANSCRIPT_TOP_PADDING_PX);
  });

  it("keeps the full padding when the chrome is rendered in flow", () => {
    expect(resolveTranscriptTopPaddingPx(0, true)).toBe(
      CHAT_PANEL_TRANSCRIPT_TOP_PADDING_PX
    );
    expect(resolveTranscriptTopPaddingPx(0, false)).toBe(
      CHAT_PANEL_TRANSCRIPT_TOP_PADDING_PX
    );
  });
});

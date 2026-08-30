// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  CHAT_PANEL_COLLAPSED_HEADER_HEIGHT_PX,
  CHAT_PANEL_GLASS_SURFACE_CLASS,
  CHAT_PANEL_HEADER_STACK_HEIGHT_PX,
  CHAT_PANEL_HEADER_TOP_PADDING_PX,
  CHAT_PANEL_PUBLISHED_HEADER_HEIGHT_PX,
  CHAT_PANEL_TRANSCRIPT_TOP_GAP_PX,
  CHAT_PANEL_TRANSCRIPT_TOP_PADDING_PX,
  resolveChatPanelChromeTopInsetPx,
  resolveTranscriptTopPaddingPx,
  shouldCollapseChatPanelTabRow,
  shouldOverlayChatSessionHeaders,
  shouldStartHeaderDragFromTarget,
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
    expect(CHAT_PANEL_HEADER_STACK_HEIGHT_PX).toBe(80);
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

describe("collapsing the tab row into the published header", () => {
  it("folds a maximized pane that holds a single tab", () => {
    expect(
      shouldCollapseChatPanelTabRow({ chatMaximized: true, tabCount: 1 })
    ).toBe(true);
  });

  it("keeps the row whenever a second tab exists to switch to", () => {
    expect(
      shouldCollapseChatPanelTabRow({ chatMaximized: true, tabCount: 2 })
    ).toBe(false);
  });

  it("keeps the row while the pane shares the workbench with a Station", () => {
    expect(
      shouldCollapseChatPanelTabRow({ chatMaximized: false, tabCount: 1 })
    ).toBe(false);
  });

  it("keeps the window-edge gap the folded tab row used to hold", () => {
    // The tab row's pt-2; the collapsed row inherits the top edge and the gap.
    expect(CHAT_PANEL_HEADER_TOP_PADDING_PX).toBe(8);
    expect(CHAT_PANEL_COLLAPSED_HEADER_HEIGHT_PX).toBe(
      CHAT_PANEL_PUBLISHED_HEADER_HEIGHT_PX + CHAT_PANEL_HEADER_TOP_PADDING_PX
    );
  });

  it("floats only the collapsed row's height once collapsed", () => {
    expect(resolveChatPanelChromeTopInsetPx(true, true)).toBe(
      CHAT_PANEL_COLLAPSED_HEADER_HEIGHT_PX
    );
    expect(resolveChatPanelChromeTopInsetPx(true, false)).toBe(
      CHAT_PANEL_HEADER_STACK_HEIGHT_PX
    );
    expect(resolveChatPanelChromeTopInsetPx(false, true)).toBe(0);
  });

  it("shrinks the transcript padding to match the collapsed chrome", () => {
    expect(
      resolveTranscriptTopPaddingPx(
        CHAT_PANEL_COLLAPSED_HEADER_HEIGHT_PX,
        false
      )
    ).toBe(
      CHAT_PANEL_COLLAPSED_HEADER_HEIGHT_PX + CHAT_PANEL_TRANSCRIPT_TOP_GAP_PX
    );
    expect(
      resolveTranscriptTopPaddingPx(CHAT_PANEL_COLLAPSED_HEADER_HEIGHT_PX, true)
    ).toBe(CHAT_PANEL_TRANSCRIPT_TOP_GAP_PX);
  });
});

describe("window drag from the folded header", () => {
  function build(html: string): HTMLElement {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host;
  }

  it("drags from the header's own background", () => {
    const host = build('<div id="bg"><span id="label">Session</span></div>');
    expect(shouldStartHeaderDragFromTarget(host.querySelector("#bg"))).toBe(
      true
    );
    // Plain text in the row is background too — nothing to click.
    expect(shouldStartHeaderDragFromTarget(host.querySelector("#label"))).toBe(
      true
    );
  });

  it("steps aside for anything the user can actually click", () => {
    for (const html of [
      '<button id="t">x</button>',
      '<a id="t" href="#">x</a>',
      '<div role="button" id="t">x</div>',
      '<div role="menuitem" id="t">x</div>',
      '<input id="t" />',
      '<div contenteditable="true" id="t">x</div>',
      // ...including when the press lands on a child of the control.
      '<button><span id="t">x</span></button>',
    ]) {
      expect(
        shouldStartHeaderDragFromTarget(build(html).querySelector("#t"))
      ).toBe(false);
    }
  });

  it("ignores a press with no target", () => {
    expect(shouldStartHeaderDragFromTarget(null)).toBe(false);
  });
});

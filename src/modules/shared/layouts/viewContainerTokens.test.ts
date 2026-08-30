import { describe, expect, it } from "vitest";

import {
  PANE_WIDTH_TRANSITION_CLASSES,
  getChatSlotLayoutStyle,
  getResizeIndicatorHostStyle,
  getWorkbenchLayoutStyle,
} from "./viewContainerTokens";

describe("pane width transitions", () => {
  it("transitions layout dimensions without transform geometry", () => {
    expect(PANE_WIDTH_TRANSITION_CLASSES).toContain("width");
    expect(PANE_WIDTH_TRANSITION_CLASSES).toContain("flex-grow");
    expect(PANE_WIDTH_TRANSITION_CLASSES).toContain("flex-basis");
    expect(PANE_WIDTH_TRANSITION_CLASSES).not.toContain("transform");
  });

  it("aligns the indicator host to the 1px divider center on either side", () => {
    expect(getResizeIndicatorHostStyle("left").transform).toBe(
      "translateX(-0.5px)"
    );
    expect(getResizeIndicatorHostStyle("right").transform).toBe(
      "translateX(0.5px)"
    );
  });

  it("collapses a hidden chat pane to an inert zero-width flex item", () => {
    expect(
      getChatSlotLayoutStyle({
        maximized: false,
        visible: false,
        visibleWidth: "var(--orgii-chat-width)",
      })
    ).toEqual({
      flexBasis: 0,
      flexGrow: 0,
      flexShrink: 0,
      pointerEvents: "none",
      width: 0,
    });
  });

  it("uses the exact configured width for a visible chat pane", () => {
    const width = "var(--orgii-chat-width)";
    expect(
      getChatSlotLayoutStyle({
        maximized: false,
        visible: true,
        visibleWidth: width,
      })
    ).toMatchObject({ flexBasis: width, pointerEvents: "auto", width });
  });

  it("exchanges normal-flow flex growth between chat and workstation", () => {
    expect(
      getChatSlotLayoutStyle({
        maximized: true,
        visible: true,
        visibleWidth: 520,
      }).flexGrow
    ).toBe(1);
    expect(getWorkbenchLayoutStyle(true).flexGrow).toBe(0);
    expect(getWorkbenchLayoutStyle(false).flexGrow).toBe(1);
  });
});

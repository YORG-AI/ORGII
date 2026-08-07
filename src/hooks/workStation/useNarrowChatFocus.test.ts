import { describe, expect, it } from "vitest";

import { resolveWorkbenchEvaluationWidth } from "./useNarrowChatFocus";

describe("resolveWorkbenchEvaluationWidth", () => {
  it("uses the projected target width during programmatic reopening", () => {
    expect(
      resolveWorkbenchEvaluationWidth({
        chatPanelDragging: false,
        chatPanelMaximized: false,
        chatVisible: true,
        chatWidth: 520,
        mainContentWidth: 1280,
        measuredWorkbenchWidth: 24,
      })
    ).toBe(760);
  });

  it("uses the projected target width while chat is maximized", () => {
    expect(
      resolveWorkbenchEvaluationWidth({
        chatPanelDragging: false,
        chatPanelMaximized: true,
        chatVisible: true,
        chatWidth: 520,
        mainContentWidth: 1280,
        measuredWorkbenchWidth: 0,
      })
    ).toBe(760);
  });

  it("uses the measured width during direct chat resizing", () => {
    expect(
      resolveWorkbenchEvaluationWidth({
        chatPanelDragging: true,
        chatPanelMaximized: false,
        chatVisible: true,
        chatWidth: 520,
        mainContentWidth: 1280,
        measuredWorkbenchWidth: 472,
      })
    ).toBe(472);
  });
});

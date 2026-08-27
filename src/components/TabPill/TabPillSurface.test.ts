import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TAB_PILL_DRAG_OVERLAY_CLASS, TabPillSurface } from "./TabPillSurface";

describe("TabPillSurface", () => {
  it("uses text-1 for selected and dragged tab surfaces", () => {
    const markup = renderToStaticMarkup(
      createElement(TabPillSurface, { isActive: true }, "Selected tab")
    );
    const activeSurface = markup.match(
      /<div[^>]*work-station-editor-tab--active[^>]*>/
    )?.[0];

    expect(activeSurface).toContain("text-text-1");
    expect(activeSurface).not.toContain("text-primary-6");
    expect(TAB_PILL_DRAG_OVERLAY_CLASS).toContain("text-text-1");
    expect(TAB_PILL_DRAG_OVERLAY_CLASS).not.toContain("text-primary-6");
  });
});

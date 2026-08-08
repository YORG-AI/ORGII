// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { GENERAL_LAYOUT_TOUR_EVENT } from "@src/scaffold/Tutorials/generalLayoutTourConfig";

import { startSidebarGuideProductTour } from "./sidebarGuideProductTour";

describe("startSidebarGuideProductTour", () => {
  it("dispatches the maintained general-layout tour event once", () => {
    const listener = vi.fn();
    window.addEventListener(GENERAL_LAYOUT_TOUR_EVENT, listener);

    startSidebarGuideProductTour();

    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(GENERAL_LAYOUT_TOUR_EVENT, listener);
  });
});

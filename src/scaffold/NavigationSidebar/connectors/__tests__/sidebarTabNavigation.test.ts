import { describe, expect, it, vi } from "vitest";

import {
  completeSidebarTabNavigation,
  resolveSidebarTabDisposition,
} from "../sidebarTabNavigation";

describe("sidebar tab navigation", () => {
  it("uses destination defaults for a plain click and new-tab for platform modifiers", () => {
    expect(
      resolveSidebarTabDisposition({ metaKey: false, ctrlKey: false })
    ).toBe("default");
    expect(
      resolveSidebarTabDisposition({ metaKey: true, ctrlKey: false })
    ).toBe("new-tab");
    expect(
      resolveSidebarTabDisposition({ metaKey: false, ctrlKey: true })
    ).toBe("new-tab");
  });

  it("closes sibling tabs only for explicit replace-all navigation", () => {
    const closeOtherTabs = vi.fn();

    completeSidebarTabNavigation("default", closeOtherTabs);
    completeSidebarTabNavigation("new-tab", closeOtherTabs);
    expect(closeOtherTabs).not.toHaveBeenCalled();

    completeSidebarTabNavigation("replace-all", closeOtherTabs);
    expect(closeOtherTabs).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it, vi } from "vitest";

import { buildOpenSidebarItemInNewTabMenuItem } from "./sidebarTabContextMenu";

describe("sidebar tab context menu", () => {
  it("builds the explicit Open in New Tab command", () => {
    const onOpen = vi.fn();
    const item = buildOpenSidebarItemInNewTabMenuItem({
      label: "Open in New Tab",
      onOpen,
    });

    expect(item).toMatchObject({ text: "Open in New Tab" });
    if ("action" in item) item.action?.("sidebar-test");
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

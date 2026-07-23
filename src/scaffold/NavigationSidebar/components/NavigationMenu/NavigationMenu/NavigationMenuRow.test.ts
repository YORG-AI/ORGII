import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { NavigationMenuItem } from "../config";
import {
  NavigationMenuLeafRow,
  NavigationMenuParentRow,
} from "./NavigationMenuRow";

const baseItem: NavigationMenuItem = {
  id: "sidebar-row",
  key: "sidebar-row",
  label: "Sidebar row",
};

describe("NavigationMenuRow", () => {
  it("uses one fixed 32px height for parent and leaf rows", () => {
    const parentMarkup = renderToStaticMarkup(
      createElement(NavigationMenuParentRow, {
        item: {
          ...baseItem,
          children: [{ ...baseItem, id: "child", key: "child" }],
        },
        isChild: false,
        isOpen: false,
        submenuSelected: false,
        collapsed: false,
        t: (key: string) => key,
        renderIcon: () => null,
        renderMenuItem: () => createElement("div"),
        onRowMouseEnter: vi.fn(),
        onRowActionClick: vi.fn(),
        onToggleSubmenu: vi.fn(),
      })
    );
    const leafMarkup = renderToStaticMarkup(
      createElement(NavigationMenuLeafRow, {
        item: baseItem,
        isChild: false,
        isSelected: false,
        collapsed: false,
        t: (key: string) => key,
        renderIcon: () => null,
        onMenuItemClick: vi.fn(),
        onRowMouseEnter: vi.fn(),
        onRowActionClick: vi.fn(),
      })
    );

    for (const markup of [parentMarkup, leafMarkup]) {
      expect(markup).toContain("flex h-8 items-center");
      expect(markup).not.toContain("min-h-[36px]");
    }
  });
});

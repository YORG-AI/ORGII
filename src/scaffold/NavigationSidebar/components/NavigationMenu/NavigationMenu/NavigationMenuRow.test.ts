// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { REFRESH_ICON_TOKENS } from "@src/components/RefreshIcon/tokens";
import { Refresh04Icon } from "@src/icons";

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

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("NavigationMenuRow", () => {
  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

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

  it("forwards the shared refresh animation class to row-action icons", () => {
    const markup = renderToStaticMarkup(
      createElement(NavigationMenuLeafRow, {
        item: {
          ...baseItem,
          showMoreActions: true,
          rowActions: [
            {
              icon: Refresh04Icon,
              dataIcon: "refresh-cw",
              iconClassName: REFRESH_ICON_TOKENS.oneShot,
              label: "Refresh",
              onClick: vi.fn(),
            },
          ],
        },
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

    // Hugeicons does not stamp an icon class the way lucide did, so identity
    // and styling are asserted separately rather than as one adjacent string.
    expect(markup).toContain('data-icon="refresh-cw"');
    expect(markup).toContain(REFRESH_ICON_TOKENS.oneShot);
  });

  it("exposes disabled leaf rows to rendered UI drivers", () => {
    const markup = renderToStaticMarkup(
      createElement(NavigationMenuLeafRow, {
        item: { ...baseItem, disabled: true },
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

    expect(markup).toContain('role="button"');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('tabindex="-1"');
  });

  it("renders guided-tour targets on parent and leaf rows", () => {
    const item = { ...baseItem, tourTarget: "runtime-navigation" };
    const parentMarkup = renderToStaticMarkup(
      createElement(NavigationMenuParentRow, {
        item: {
          ...item,
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
        item,
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
      expect(markup).toContain('data-tour-target="runtime-navigation"');
    }
  });

  it("activates enabled leaf rows with Enter and Space", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onMenuItemClick = vi.fn();

    await act(async () => {
      root.render(
        createElement(NavigationMenuLeafRow, {
          item: baseItem,
          isChild: false,
          isSelected: false,
          collapsed: false,
          t: (key: string) => key,
          renderIcon: () => null,
          onMenuItemClick,
          onRowMouseEnter: vi.fn(),
          onRowActionClick: vi.fn(),
        })
      );
    });

    const row = container.querySelector<HTMLElement>('[role="button"]');
    expect(row).not.toBeNull();

    await act(async () => {
      row?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
      row?.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true })
      );
    });

    expect(onMenuItemClick).toHaveBeenCalledTimes(2);

    act(() => root.unmount());
    container.remove();
  });

  it("swaps the accessory slot instantly, with no reveal animation", () => {
    const markup = renderToStaticMarkup(
      createElement(NavigationMenuLeafRow, {
        item: {
          ...baseItem,
          shortcut: "21h",
          showMoreActions: true,
          trailingElement: createElement("span", null, "dot"),
        },
        isChild: false,
        isSelected: false,
        collapsed: false,
        t: (key: string) => key,
        renderIcon: () => null,
        onMenuItemClick: vi.fn(),
        onMenuItemContextMenu: vi.fn(),
        onRowMouseEnter: vi.fn(),
        onRowActionClick: vi.fn(),
      })
    );

    // The reveal must not animate: an animated width reflowed the label on
    // every frame, and the crossfade left the persistent glyph painted over the
    // `more` button for the duration. The layer still collapses at rest so the
    // label keeps its width — it just resizes in one step.
    expect(markup).not.toContain("transition-[max-width");
    expect(markup).not.toContain("transition-opacity");
    expect(markup).toContain("max-w-0");
    expect(markup).toContain("group-hover:opacity-0");
    expect(markup).toContain("group-hover:opacity-100");

    // The 2px edge nudge must sit ON the `overflow-hidden` layer. Inside it,
    // those 2px fall outside the clip rect and shear the last button's right
    // edge — which is exactly what the sidebar showed.
    const clippingLayer = markup.match(
      /class="[^"]*overflow-hidden[^"]*max-w-0[^"]*"|class="[^"]*max-w-0[^"]*overflow-hidden[^"]*"/
    )?.[0];
    expect(clippingLayer).toBeDefined();
    expect(clippingLayer).toContain("-mr-0.5");
    expect(markup).not.toContain('class="-mr-0.5');
  });
});

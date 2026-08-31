import { describe, expect, it } from "vitest";

import {
  type SubmenuAnchor,
  type SubmenuRect,
  clampSubmenuTop,
  getSubmenuAnchor,
} from "./submenuLayout";
import { DROPDOWN_PANEL } from "./tokens";

function rect({
  top,
  left,
  width,
  height,
}: {
  top: number;
  left: number;
  width: number;
  height: number;
}): SubmenuRect {
  return { bottom: top + height, left, right: left + width, top };
}

describe("getSubmenuAnchor", () => {
  it("opens to the right of the panel and aligns with the row", () => {
    const anchor = getSubmenuAnchor({
      triggerRect: rect({ top: 280, left: 20, width: 380, height: 32 }),
      parentRect: rect({ top: 40, left: 20, width: 380, height: 660 }),
      submenuWidth: 220,
      viewportWidth: 1440,
      viewportHeight: 900,
      opensUpward: false,
    });

    expect(anchor).toEqual({
      left: 400 + DROPDOWN_PANEL.submenuGap,
      opensUpward: false,
      parentBottom: 700,
      parentTop: 40,
      top: 276,
    });
  });

  it("flips to the left of the panel when the right side would overflow", () => {
    const anchor = getSubmenuAnchor({
      triggerRect: rect({ top: 100, left: 1000, width: 200, height: 32 }),
      parentRect: rect({ top: 60, left: 1000, width: 200, height: 300 }),
      submenuWidth: 220,
      viewportWidth: 1280,
      viewportHeight: 900,
      opensUpward: false,
    });

    expect(anchor.left).toBe(1000 - 220 - DROPDOWN_PANEL.submenuGap);
  });

  it.each([0, 5, 12])(
    "keeps the same panel-to-panel gap with a %ipx row inset on either side",
    (inset) => {
      for (const viewportWidth of [1440, 600]) {
        const parent = rect({ top: 40, left: 240, width: 200, height: 400 });
        const anchor = getSubmenuAnchor({
          triggerRect: rect({
            top: 280,
            left: parent.left + inset,
            width: 200 - 2 * inset,
            height: 32,
          }),
          parentRect: parent,
          submenuWidth: 220,
          viewportWidth,
          viewportHeight: 900,
          opensUpward: true,
        });

        const gap =
          viewportWidth === 1440
            ? anchor.left - parent.right
            : parent.left - (anchor.left + 220);
        expect(gap).toBe(DROPDOWN_PANEL.submenuGap);
        expect(anchor.top).toBe(280 - DROPDOWN_PANEL.padding);
      }
    }
  );

  it("preserves the Appearance menu's established visible gap", () => {
    expect(DROPDOWN_PANEL.submenuGap).toBe(3);
  });

  it("falls back to viewport bounds when the parent panel is not mounted", () => {
    const anchor = getSubmenuAnchor({
      triggerRect: rect({ top: 4, left: 20, width: 180, height: 32 }),
      parentRect: null,
      submenuWidth: 220,
      viewportWidth: 1440,
      viewportHeight: 900,
      opensUpward: true,
    });

    expect(anchor.parentTop).toBe(8);
    expect(anchor.parentBottom).toBe(892);
    expect(anchor.left).toBe(200 + DROPDOWN_PANEL.submenuGap);
    // Never above the viewport padding, even for a row near the top edge.
    expect(anchor.top).toBe(8);
  });
});

function anchorWith(overrides: Partial<SubmenuAnchor> = {}): SubmenuAnchor {
  return {
    left: 408,
    opensUpward: false,
    parentBottom: 700,
    parentTop: 40,
    top: 276,
    ...overrides,
  };
}

describe("clampSubmenuTop", () => {
  it("keeps a short submenu at its row-aligned top", () => {
    expect(
      clampSubmenuTop({
        anchor: anchorWith(),
        submenuHeight: 160,
        viewportHeight: 900,
      })
    ).toBe(276);
  });

  it("pulls a submenu up so it stops at the parent menu's bottom", () => {
    expect(
      clampSubmenuTop({
        anchor: anchorWith({ top: 640 }),
        submenuHeight: 200,
        viewportHeight: 900,
      })
    ).toBe(500);
  });

  it("bottom-aligns a too-tall submenu with an upward-opening parent", () => {
    expect(
      clampSubmenuTop({
        anchor: anchorWith({
          opensUpward: true,
          parentTop: 80,
          parentBottom: 600,
          top: 396,
        }),
        submenuHeight: 560,
        viewportHeight: 900,
      })
    ).toBe(40);
  });

  it("top-aligns a too-tall submenu with a downward-opening parent", () => {
    expect(
      clampSubmenuTop({
        anchor: anchorWith({ parentTop: 80, parentBottom: 600, top: 396 }),
        submenuHeight: 560,
        viewportHeight: 900,
      })
    ).toBe(80);
  });

  it("never pushes the submenu past the viewport's bottom padding", () => {
    expect(
      clampSubmenuTop({
        anchor: anchorWith({ parentBottom: 2000, top: 800 }),
        submenuHeight: 300,
        viewportHeight: 900,
      })
    ).toBe(592);
  });
});

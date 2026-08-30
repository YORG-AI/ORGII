import { describe, expect, it } from "vitest";

import {
  type SubmenuAnchor,
  type SubmenuRect,
  clampSubmenuTop,
  getSubmenuAnchor,
} from "./submenuLayout";

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
  it("opens to the right of the row and aligns with it", () => {
    const anchor = getSubmenuAnchor({
      triggerRect: rect({ top: 280, left: 20, width: 380, height: 32 }),
      parentRect: rect({ top: 40, left: 20, width: 380, height: 660 }),
      submenuWidth: 220,
      viewportWidth: 1440,
      viewportHeight: 900,
      opensUpward: false,
    });

    expect(anchor).toEqual({
      left: 408,
      opensUpward: false,
      parentBottom: 700,
      parentTop: 40,
      top: 276,
    });
  });

  it("flips to the left of the row when the right side would overflow", () => {
    const anchor = getSubmenuAnchor({
      triggerRect: rect({ top: 100, left: 1000, width: 200, height: 32 }),
      parentRect: rect({ top: 60, left: 1000, width: 200, height: 300 }),
      submenuWidth: 220,
      viewportWidth: 1280,
      viewportHeight: 900,
      opensUpward: false,
    });

    expect(anchor.left).toBe(772);
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

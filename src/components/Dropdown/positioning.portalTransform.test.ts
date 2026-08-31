// @vitest-environment node
import { describe, expect, it } from "vitest";

import { calculateDropdownPosition, getPortalTransform } from "./positioning";
import { DROPDOWN_PANEL } from "./tokens";

function fakeElement(rect: Partial<DOMRect>): HTMLElement {
  return {
    getBoundingClientRect: () => ({
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      ...rect,
    }),
  } as unknown as HTMLElement;
}

describe("getPortalTransform", () => {
  // Portal-mode coordinates anchor `left*` panels at the trigger's left edge,
  // so every left placement must shift the panel by its own width — otherwise
  // it renders over the trigger instead of beside it (regression: the
  // workstation trail's environment dropdown was invisible/overlapping).
  it("shifts left placements fully to the left of the anchor", () => {
    expect(getPortalTransform("left")).toBe("translate(-100%, -50%)");
    expect(getPortalTransform("left-start")).toBe("translateX(-100%)");
    expect(getPortalTransform("left-end")).toBe("translate(-100%, -100%)");
  });

  it("keeps right placements anchored at the trigger's right edge", () => {
    expect(getPortalTransform("right")).toBe("translateY(-50%)");
    expect(getPortalTransform("right-start")).toBeUndefined();
    expect(getPortalTransform("right-end")).toBe("translateY(-100%)");
  });
});

describe("calculateDropdownPosition left placements", () => {
  const trigger = fakeElement({
    top: 100,
    left: 500,
    width: 240,
    height: 28,
    right: 740,
    bottom: 128,
  });
  const container = fakeElement({});
  const panel = fakeElement({ width: 180, height: 80 });
  const gap = DROPDOWN_PANEL.triggerGapTight;

  // The entry animation (`animate-dropdown-in`) animates `transform`, which
  // suppresses an inline placement transform while it runs. Measured left
  // placements must therefore land entirely through coordinates.
  it("bakes the panel shift into coordinates once the panel is measured", () => {
    const centered = calculateDropdownPosition({
      position: "left",
      triggerElement: trigger,
      containerElement: container,
      dropdownElement: panel,
      avoidViewportOverflow: false,
    });
    expect(centered).toEqual({
      top: 100 + 28 / 2 - 80 / 2,
      left: 500 - gap - 180,
      transform: undefined,
    });

    const start = calculateDropdownPosition({
      position: "left-start",
      triggerElement: trigger,
      containerElement: container,
      dropdownElement: panel,
      avoidViewportOverflow: false,
    });
    expect(start).toEqual({
      top: 100,
      left: 500 - gap - 180,
      transform: undefined,
    });

    const end = calculateDropdownPosition({
      position: "left-end",
      triggerElement: trigger,
      containerElement: container,
      dropdownElement: panel,
      avoidViewportOverflow: false,
    });
    expect(end).toEqual({
      top: 100 + 28 - 80,
      left: 500 - gap - 180,
      transform: undefined,
    });
  });

  it("falls back to a transform while the panel is not yet measurable", () => {
    const unmeasured = calculateDropdownPosition({
      position: "left",
      triggerElement: trigger,
      containerElement: container,
      dropdownElement: null,
      avoidViewportOverflow: false,
    });
    expect(unmeasured).toEqual({
      top: 100 + 28 / 2,
      left: 500 - gap,
      transform: "translate(-100%, -50%)",
    });
  });
});

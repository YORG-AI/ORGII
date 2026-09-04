import { describe, expect, it } from "vitest";

import {
  applyFloatingHorizontalFrame,
  computeFloatingPosition,
  insetFloatingHorizontalFrame,
} from "./floatingPlacement";

describe("insetFloatingHorizontalFrame", () => {
  it("centers a menu within equal 24px composer side insets", () => {
    expect(
      insetFloatingHorizontalFrame({ left: 80, width: 1600, inset: 24 })
    ).toEqual({ left: 104, width: 1552 });
  });

  it("clamps the inset when a frame is too narrow", () => {
    expect(
      insetFloatingHorizontalFrame({ left: 12, width: 32, inset: 24 })
    ).toEqual({ left: 28, width: 0 });
  });
});

describe("applyFloatingHorizontalFrame", () => {
  it("preserves prototype-backed DOMRect vertical coordinates", () => {
    const anchorRect = Object.create({ top: 120, bottom: 180, left: 80 });

    expect(
      applyFloatingHorizontalFrame(anchorRect, { left: 104, width: 1552 })
    ).toEqual({ top: 120, bottom: 180, left: 104 });
  });
});

describe("computeFloatingPosition", () => {
  it("keeps the configured vertical gap above the input", () => {
    expect(
      computeFloatingPosition({
        anchorRect: { top: 400, bottom: 500, left: 100 },
        floatingWidth: 600,
        floatingHeight: 200,
        placement: "up",
        viewportWidth: 1000,
        viewportHeight: 800,
        margin: 8,
        gap: 8,
      })
    ).toMatchObject({
      bottom: 408,
      left: 100,
      placement: "up",
    });
  });
});

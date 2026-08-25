// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  type ClippingRect,
  type RectEdges,
  computeVisibleWebviewRect,
  getVisibleWebviewRect,
} from "../visibleWebviewRect";

function rect(
  left: number,
  top: number,
  right: number,
  bottom: number
): RectEdges {
  return { left, top, right, bottom };
}

function expectRect(
  actual: DOMRect | null,
  expected: RectEdges & { width: number; height: number }
) {
  expect(actual).toMatchObject(expected);
}

describe("computeVisibleWebviewRect", () => {
  const viewport = rect(0, 0, 1_000, 800);

  it("keeps a fully visible anchor unchanged", () => {
    expectRect(computeVisibleWebviewRect(rect(100, 80, 700, 500), viewport), {
      left: 100,
      top: 80,
      right: 700,
      bottom: 500,
      width: 600,
      height: 420,
    });
  });

  it("clips an anchor that is only partially inside the viewport", () => {
    expectRect(
      computeVisibleWebviewRect(rect(-40, 100, 1_040, 900), viewport),
      {
        left: 0,
        top: 100,
        right: 1_000,
        bottom: 800,
        width: 1_000,
        height: 700,
      }
    );
  });

  it("returns null when the anchor is completely outside the viewport", () => {
    expect(
      computeVisibleWebviewRect(rect(1_001, 100, 1_200, 300), viewport)
    ).toBeNull();
  });

  it("intersects multiple clipping ancestors on their configured axes", () => {
    const ancestors: ClippingRect[] = [
      { rect: rect(120, -1_000, 900, 1_000), clipX: true, clipY: false },
      { rect: rect(-1_000, 140, 2_000, 620), clipX: false, clipY: true },
      { rect: rect(180, 180, 840, 580), clipX: true, clipY: true },
    ];

    expectRect(
      computeVisibleWebviewRect(rect(100, 100, 950, 700), viewport, ancestors),
      {
        left: 180,
        top: 180,
        right: 840,
        bottom: 580,
        width: 660,
        height: 400,
      }
    );
  });

  it("returns null when an ancestor fully clips the visible anchor", () => {
    expect(
      computeVisibleWebviewRect(rect(100, 100, 500, 500), viewport, [
        { rect: rect(600, 0, 900, 800), clipX: true, clipY: false },
      ])
    ).toBeNull();
  });

  it.each([
    ["zero-width anchor", rect(100, 100, 100, 200), viewport, []],
    ["zero-height viewport", rect(100, 100, 200, 200), rect(0, 0, 500, 0), []],
    ["non-finite anchor", rect(100, 100, Number.NaN, 200), viewport, []],
    [
      "zero-width clipping ancestor",
      rect(100, 100, 200, 200),
      viewport,
      [{ rect: rect(150, 0, 150, 800), clipX: true, clipY: false }],
    ],
  ] satisfies Array<[string, RectEdges, RectEdges, readonly ClippingRect[]]>)(
    "returns null for %s",
    (_name, anchor, viewportRect, ancestors) => {
      expect(
        computeVisibleWebviewRect(anchor, viewportRect, ancestors)
      ).toBeNull();
    }
  );

  it("ignores an invalid ancestor that does not clip either axis", () => {
    expectRect(
      computeVisibleWebviewRect(rect(100, 100, 200, 200), viewport, [
        {
          rect: rect(Number.NaN, Number.NaN, Number.NaN, Number.NaN),
          clipX: false,
          clipY: false,
        },
      ]),
      {
        left: 100,
        top: 100,
        right: 200,
        bottom: 200,
        width: 100,
        height: 100,
      }
    );
  });
});

describe("getVisibleWebviewRect", () => {
  it("collects hidden, clip, auto, and scroll ancestors while ignoring visible overflow", () => {
    Object.defineProperties(document.documentElement, {
      clientWidth: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 800 },
    });

    const visibleParent = document.createElement("div");
    visibleParent.style.overflow = "visible";
    const outerClip = document.createElement("div");
    outerClip.style.overflowX = "hidden";
    outerClip.style.overflowY = "visible";
    const explicitClip = document.createElement("div");
    explicitClip.style.overflowY = "clip";
    const scrollClip = document.createElement("div");
    scrollClip.style.overflowX = "auto";
    scrollClip.style.overflowY = "scroll";
    const anchor = document.createElement("div");

    document.body.append(visibleParent);
    visibleParent.append(outerClip);
    outerClip.append(explicitClip);
    explicitClip.append(scrollClip);
    scrollClip.append(anchor);

    visibleParent.getBoundingClientRect = () =>
      rect(-500, -500, 500, 500) as DOMRect;
    outerClip.getBoundingClientRect = () => rect(100, 0, 900, 800) as DOMRect;
    explicitClip.getBoundingClientRect = () =>
      rect(0, 120, 1_000, 680) as DOMRect;
    scrollClip.getBoundingClientRect = () => rect(0, 80, 1_000, 720) as DOMRect;
    anchor.getBoundingClientRect = () => rect(20, 20, 980, 760) as DOMRect;

    expectRect(getVisibleWebviewRect(anchor), {
      left: 100,
      top: 120,
      right: 900,
      bottom: 680,
      width: 800,
      height: 560,
    });

    visibleParent.remove();
  });
});

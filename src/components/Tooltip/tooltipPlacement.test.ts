import { describe, expect, it } from "vitest";

import {
  type TooltipRectLike,
  type TooltipViewport,
  getBestTooltipCandidate,
  getTooltipCoordinates,
  getTooltipFallbackPositions,
  getTooltipOverflow,
  getTooltipOverflowScore,
  getTooltipPositionSide,
  withTooltipPositionSide,
} from "./tooltipPlacement";

const trigger: TooltipRectLike = {
  top: 100,
  right: 200,
  bottom: 130,
  left: 100,
  width: 100,
  height: 30,
};

const tooltipSize = { width: 50, height: 20 };

const viewport: TooltipViewport = { width: 1000, height: 800, padding: 8 };

describe("getTooltipPositionSide", () => {
  it("returns the bare side for a plain position", () => {
    expect(getTooltipPositionSide("top")).toBe("top");
    expect(getTooltipPositionSide("right")).toBe("right");
  });

  it("strips the alignment suffix", () => {
    expect(getTooltipPositionSide("bottom-start")).toBe("bottom");
    expect(getTooltipPositionSide("left-end")).toBe("left");
  });
});

describe("withTooltipPositionSide", () => {
  it("swaps the side and keeps the alignment", () => {
    expect(withTooltipPositionSide("top-start", "bottom")).toBe("bottom-start");
    expect(withTooltipPositionSide("left-end", "right")).toBe("right-end");
  });

  it("drops to the bare side when there is no alignment", () => {
    expect(withTooltipPositionSide("top", "bottom")).toBe("bottom");
  });
});

describe("getTooltipFallbackPositions", () => {
  it("orders requested, opposite, then both alignments of each", () => {
    expect(getTooltipFallbackPositions("top")).toEqual([
      "top",
      "bottom",
      "top-start",
      "bottom-start",
      "top-end",
      "bottom-end",
    ]);
  });

  it("skips the alignment already requested", () => {
    expect(getTooltipFallbackPositions("left-start")).toEqual([
      "left-start",
      "right-start",
      "left-end",
      "right-end",
    ]);
    expect(getTooltipFallbackPositions("right-end")).toEqual([
      "right-end",
      "left-end",
      "right-start",
      "left-start",
    ]);
  });

  it("never repeats a candidate", () => {
    for (const position of [
      "top",
      "bottom-start",
      "left-end",
      "right",
    ] as const) {
      const positions = getTooltipFallbackPositions(position);
      expect(new Set(positions).size).toBe(positions.length);
      expect(positions[0]).toBe(position);
    }
  });
});

describe("getTooltipCoordinates", () => {
  it("centres the tooltip on the trigger for bare sides", () => {
    expect(getTooltipCoordinates("top", trigger, tooltipSize, 8)).toEqual({
      top: 72,
      left: 125,
    });
    expect(getTooltipCoordinates("bottom", trigger, tooltipSize, 8)).toEqual({
      top: 138,
      left: 125,
    });
    expect(getTooltipCoordinates("left", trigger, tooltipSize, 8)).toEqual({
      top: 105,
      left: 42,
    });
    expect(getTooltipCoordinates("right", trigger, tooltipSize, 8)).toEqual({
      top: 105,
      left: 208,
    });
  });

  it("aligns to the trigger edges for -start and -end", () => {
    expect(getTooltipCoordinates("top-start", trigger, tooltipSize, 8)).toEqual(
      { top: 72, left: 100 }
    );
    expect(getTooltipCoordinates("top-end", trigger, tooltipSize, 8)).toEqual({
      top: 72,
      left: 150,
    });
    expect(
      getTooltipCoordinates("left-start", trigger, tooltipSize, 8)
    ).toEqual({ top: 100, left: 42 });
    expect(getTooltipCoordinates("left-end", trigger, tooltipSize, 8)).toEqual({
      top: 110,
      left: 42,
    });
  });

  it("applies the gap along the placement axis only", () => {
    const tight = getTooltipCoordinates("top", trigger, tooltipSize, 0);
    const loose = getTooltipCoordinates("top", trigger, tooltipSize, 12);
    expect(loose.top).toBe(tight.top - 12);
    expect(loose.left).toBe(tight.left);
  });
});

describe("getTooltipOverflow", () => {
  it("reports zero on every edge when the tooltip fits", () => {
    expect(
      getTooltipOverflow({ top: 100, left: 100 }, tooltipSize, viewport)
    ).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it("measures against the padded viewport edges", () => {
    expect(
      getTooltipOverflow({ top: -4, left: 5 }, tooltipSize, {
        width: 100,
        height: 100,
        padding: 8,
      })
    ).toEqual({ top: 12, right: 0, bottom: 0, left: 3 });
  });

  it("measures the far edges from the tooltip size", () => {
    expect(
      getTooltipOverflow({ top: 90, left: 60 }, tooltipSize, {
        width: 100,
        height: 100,
        padding: 8,
      })
    ).toEqual({ top: 0, right: 18, bottom: 18, left: 0 });
  });
});

describe("getTooltipOverflowScore", () => {
  it("sums all four edges", () => {
    expect(
      getTooltipOverflowScore({ top: 1, right: 2, bottom: 3, left: 4 })
    ).toBe(10);
  });
});

describe("getBestTooltipCandidate", () => {
  const clipped: TooltipRectLike = {
    top: 10,
    right: 200,
    bottom: 40,
    left: 100,
    width: 100,
    height: 30,
  };
  const bigTooltip = { width: 80, height: 40 };

  it("keeps the requested placement when smart placement is off", () => {
    const candidate = getBestTooltipCandidate(
      "top",
      clipped,
      bigTooltip,
      8,
      viewport,
      false
    );
    expect(candidate.position).toBe("top");
    expect(candidate.coordinates).toEqual({ top: -38, left: 110 });
    expect(candidate.overflowScore).toBe(46);
  });

  it("flips to the opposite side when smart placement is on", () => {
    const candidate = getBestTooltipCandidate(
      "top",
      clipped,
      bigTooltip,
      8,
      viewport,
      true
    );
    expect(candidate.position).toBe("bottom");
    expect(candidate.coordinates).toEqual({ top: 48, left: 110 });
    expect(candidate.overflowScore).toBe(0);
  });

  it("prefers the earliest fallback when scores tie", () => {
    const candidate = getBestTooltipCandidate(
      "top",
      trigger,
      tooltipSize,
      8,
      viewport,
      true
    );
    expect(candidate.position).toBe("top");
    expect(candidate.overflowScore).toBe(0);
  });

  it("returns the least-overflowing candidate when none fit", () => {
    const tiny: TooltipViewport = { width: 60, height: 60, padding: 8 };
    const candidate = getBestTooltipCandidate(
      "top",
      trigger,
      tooltipSize,
      8,
      tiny,
      true
    );
    const scores = getTooltipFallbackPositions("top").map((position) =>
      getTooltipOverflowScore(
        getTooltipOverflow(
          getTooltipCoordinates(position, trigger, tooltipSize, 8),
          tooltipSize,
          tiny
        )
      )
    );
    expect(candidate.overflowScore).toBe(Math.min(...scores));
    expect(candidate.overflowScore).toBeGreaterThan(0);
  });
});

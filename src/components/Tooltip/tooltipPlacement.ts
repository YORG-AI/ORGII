/**
 * Tooltip placement geometry.
 *
 * Pure viewport math shared by the Tooltip component: candidate coordinates
 * per placement, overflow measurement against the viewport, and the
 * smart-placement fallback ordering. No React, no DOM reads — callers pass
 * plain rect-like objects so the functions stay unit-testable.
 */

export type TooltipPosition =
  | "top"
  | "top-start"
  | "top-end"
  | "bottom"
  | "bottom-start"
  | "bottom-end"
  | "left"
  | "left-start"
  | "left-end"
  | "right"
  | "right-start"
  | "right-end";

export type TooltipCoordinates = { top: number; left: number };

export type TooltipOverflow = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type TooltipPlacementCandidate = {
  position: TooltipPosition;
  coordinates: TooltipCoordinates;
  overflow: TooltipOverflow;
  overflowScore: number;
};

export type TooltipRectLike = Pick<
  DOMRect,
  "top" | "right" | "bottom" | "left" | "width" | "height"
>;

export type TooltipSizeLike = Pick<DOMRect, "width" | "height">;

export type TooltipViewport = {
  width: number;
  height: number;
  padding: number;
};

export type TooltipPositionSide = "top" | "right" | "bottom" | "left";

const TOOLTIP_OPPOSITE_SIDE: Record<TooltipPositionSide, TooltipPositionSide> =
  {
    top: "bottom",
    right: "left",
    bottom: "top",
    left: "right",
  };

export function getTooltipPositionSide(
  position: TooltipPosition
): TooltipPositionSide {
  return position.split("-")[0] as TooltipPositionSide;
}

export function withTooltipPositionSide(
  position: TooltipPosition,
  side: TooltipPositionSide
): TooltipPosition {
  const alignment = position.includes("-") ? position.split("-")[1] : "";
  return alignment ? (`${side}-${alignment}` as TooltipPosition) : side;
}

export function getTooltipFallbackPositions(
  position: TooltipPosition
): TooltipPosition[] {
  const side = getTooltipPositionSide(position);
  const opposite = withTooltipPositionSide(
    position,
    TOOLTIP_OPPOSITE_SIDE[side]
  );
  const positions = [position, opposite];

  if (!position.endsWith("-start")) {
    positions.push(`${side}-start` as TooltipPosition);
    positions.push(
      `${getTooltipPositionSide(opposite)}-start` as TooltipPosition
    );
  }

  if (!position.endsWith("-end")) {
    positions.push(`${side}-end` as TooltipPosition);
    positions.push(
      `${getTooltipPositionSide(opposite)}-end` as TooltipPosition
    );
  }

  return Array.from(new Set(positions));
}

export function getTooltipCoordinates(
  position: TooltipPosition,
  triggerRect: TooltipRectLike,
  tooltipRect: TooltipSizeLike,
  gap: number
): TooltipCoordinates {
  switch (position) {
    case "top":
      return {
        top: triggerRect.top - tooltipRect.height - gap,
        left: triggerRect.left + (triggerRect.width - tooltipRect.width) / 2,
      };
    case "top-start":
      return {
        top: triggerRect.top - tooltipRect.height - gap,
        left: triggerRect.left,
      };
    case "top-end":
      return {
        top: triggerRect.top - tooltipRect.height - gap,
        left: triggerRect.right - tooltipRect.width,
      };
    case "bottom":
      return {
        top: triggerRect.bottom + gap,
        left: triggerRect.left + (triggerRect.width - tooltipRect.width) / 2,
      };
    case "bottom-start":
      return {
        top: triggerRect.bottom + gap,
        left: triggerRect.left,
      };
    case "bottom-end":
      return {
        top: triggerRect.bottom + gap,
        left: triggerRect.right - tooltipRect.width,
      };
    case "left":
      return {
        top: triggerRect.top + (triggerRect.height - tooltipRect.height) / 2,
        left: triggerRect.left - tooltipRect.width - gap,
      };
    case "left-start":
      return {
        top: triggerRect.top,
        left: triggerRect.left - tooltipRect.width - gap,
      };
    case "left-end":
      return {
        top: triggerRect.bottom - tooltipRect.height,
        left: triggerRect.left - tooltipRect.width - gap,
      };
    case "right":
      return {
        top: triggerRect.top + (triggerRect.height - tooltipRect.height) / 2,
        left: triggerRect.right + gap,
      };
    case "right-start":
      return {
        top: triggerRect.top,
        left: triggerRect.right + gap,
      };
    case "right-end":
      return {
        top: triggerRect.bottom - tooltipRect.height,
        left: triggerRect.right + gap,
      };
  }
}

export function getTooltipOverflow(
  coordinates: TooltipCoordinates,
  tooltipRect: TooltipSizeLike,
  viewport: TooltipViewport
): TooltipOverflow {
  return {
    top: Math.max(0, viewport.padding - coordinates.top),
    right: Math.max(
      0,
      coordinates.left + tooltipRect.width - (viewport.width - viewport.padding)
    ),
    bottom: Math.max(
      0,
      coordinates.top +
        tooltipRect.height -
        (viewport.height - viewport.padding)
    ),
    left: Math.max(0, viewport.padding - coordinates.left),
  };
}

export function getTooltipOverflowScore(overflow: TooltipOverflow): number {
  return overflow.top + overflow.right + overflow.bottom + overflow.left;
}

export function getBestTooltipCandidate(
  position: TooltipPosition,
  triggerRect: TooltipRectLike,
  tooltipRect: TooltipSizeLike,
  gap: number,
  viewport: TooltipViewport,
  smartPlacement: boolean
): TooltipPlacementCandidate {
  const candidates = (
    smartPlacement ? getTooltipFallbackPositions(position) : [position]
  ).map((candidatePosition) => {
    const coordinates = getTooltipCoordinates(
      candidatePosition,
      triggerRect,
      tooltipRect,
      gap
    );
    const overflow = getTooltipOverflow(coordinates, tooltipRect, viewport);
    return {
      position: candidatePosition,
      coordinates,
      overflow,
      overflowScore: getTooltipOverflowScore(overflow),
    };
  });

  return candidates.reduce((best, candidate) =>
    candidate.overflowScore < best.overflowScore ? candidate : best
  );
}

import { DROPDOWN_PANEL } from "@src/components/Dropdown/tokens";
import { getViewportSize } from "@src/util/ui/window/viewport";

export type FloatingPlacement = "up" | "down";
export type FloatingPlacementStrategy =
  | "prefer-up"
  | "prefer-down"
  | FloatingPlacement;

export interface FloatingAnchorRect {
  top: number;
  bottom: number;
  left: number;
}

export interface FloatingPosition {
  top?: number;
  bottom?: number;
  left: number;
  placement: FloatingPlacement;
  availableHeight: number;
}

export interface FloatingHorizontalFrame {
  left: number;
  width: number;
}

/** Inset a floating surface equally from both sides of its horizontal frame. */
export function insetFloatingHorizontalFrame({
  left,
  width,
  inset,
}: FloatingHorizontalFrame & { inset: number }): FloatingHorizontalFrame {
  const resolvedInset = Math.min(Math.max(0, inset), width / 2);
  return {
    left: left + resolvedInset,
    width: width - resolvedInset * 2,
  };
}

/** Preserve vertical geometry when applying a separately measured frame. */
export function applyFloatingHorizontalFrame(
  anchorRect: FloatingAnchorRect,
  horizontalFrame: FloatingHorizontalFrame
): FloatingAnchorRect {
  return {
    top: anchorRect.top,
    bottom: anchorRect.bottom,
    left: horizontalFrame.left,
  };
}

interface ComputeFloatingPositionOptions {
  anchorRect: FloatingAnchorRect;
  floatingWidth: number;
  floatingHeight: number;
  placement?: FloatingPlacementStrategy;
  viewportWidth?: number;
  viewportHeight?: number;
  margin?: number;
  gap?: number;
  minAvailableHeight?: number;
}

const DEFAULT_VIEWPORT_MARGIN = 8;
const DEFAULT_MIN_AVAILABLE_HEIGHT = 120;

function clampToViewport(
  value: number,
  size: number,
  viewportSize: number,
  margin: number
): number {
  const maxValue = Math.max(margin, viewportSize - size - margin);
  return Math.min(Math.max(margin, value), maxValue);
}

function resolveFloatingPlacement(
  strategy: FloatingPlacementStrategy,
  floatingHeight: number,
  spaceAbove: number,
  spaceBelow: number
): FloatingPlacement {
  if (strategy === "up" || strategy === "down") return strategy;
  if (strategy === "prefer-down") {
    return floatingHeight > spaceBelow && spaceAbove > spaceBelow
      ? "up"
      : "down";
  }
  return floatingHeight > spaceAbove && spaceBelow > spaceAbove ? "down" : "up";
}

export function computeFloatingPosition({
  anchorRect,
  floatingWidth,
  floatingHeight,
  placement = "prefer-up",
  viewportWidth = getViewportSize().width,
  viewportHeight = getViewportSize().height,
  margin = DEFAULT_VIEWPORT_MARGIN,
  gap = DROPDOWN_PANEL.triggerGap,
  minAvailableHeight = DEFAULT_MIN_AVAILABLE_HEIGHT,
}: ComputeFloatingPositionOptions): FloatingPosition {
  const spaceAbove = anchorRect.top - gap - margin;
  const spaceBelow = viewportHeight - anchorRect.bottom - gap - margin;
  const resolvedPlacement = resolveFloatingPlacement(
    placement,
    floatingHeight,
    spaceAbove,
    spaceBelow
  );
  const availableHeight =
    resolvedPlacement === "down" ? spaceBelow : spaceAbove;
  const effectiveHeight = Math.min(
    floatingHeight,
    Math.max(minAvailableHeight, Math.floor(availableHeight))
  );
  const top =
    resolvedPlacement === "down"
      ? clampToViewport(
          anchorRect.bottom + gap,
          effectiveHeight,
          viewportHeight,
          margin
        )
      : undefined;
  const bottom =
    resolvedPlacement === "up"
      ? Math.max(margin, viewportHeight - anchorRect.top + gap)
      : undefined;

  return {
    top,
    bottom,
    left: clampToViewport(
      anchorRect.left,
      floatingWidth,
      viewportWidth,
      margin
    ),
    placement: resolvedPlacement,
    availableHeight: Math.max(minAvailableHeight, Math.floor(availableHeight)),
  };
}

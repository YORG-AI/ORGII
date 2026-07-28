/**
 * Shared inline style builder for panels positioned by `useDropdownEngine`.
 *
 * Every portal panel needs the same translation from `panelPosition` to CSS:
 * pick `top` or `bottom` depending on which way the panel flipped, pick
 * `left` or `right` depending on alignment, mirror the trigger width, and
 * cap the height to the space the engine measured on the resolved side.
 * Keeping it here means a panel picks up flip/clamp behaviour for free
 * instead of re-deriving it (usually incompletely) at each call site.
 */
import type { CSSProperties } from "react";

import type { DropdownEnginePosition } from "./useDropdownEngine";

export interface DropdownPanelStyleOptions {
  /**
   * How the trigger width feeds the panel.
   * - `"min"` (default): trigger width becomes `min-width`
   * - `"match"`: trigger width becomes `width`
   * - `"none"`: panel sizes to its own content
   */
  widthMode?: "min" | "match" | "none";
  /**
   * Apply the engine's container-aware `max-height`. Turn off for panels
   * that are always short or that own their scrolling elsewhere.
   * @default true
   */
  constrainHeight?: boolean;
  /**
   * Upper bound for the emitted `max-height`. Pass the panel's own design
   * cap so the inline value can only ever shrink it — an inline style beats
   * a `max-h-*` class, so without this a tall viewport would let the panel
   * grow past the height its class intended.
   */
  maxHeightCap?: number;
}

export function getDropdownPanelStyle(
  position: DropdownEnginePosition,
  {
    widthMode = "min",
    constrainHeight = true,
    maxHeightCap,
  }: DropdownPanelStyleOptions = {}
): CSSProperties {
  return {
    ...(position.top !== undefined
      ? { top: `${position.top}px` }
      : { bottom: `${position.bottom}px` }),
    ...(position.right !== undefined
      ? { right: `${position.right}px` }
      : { left: `${position.left}px` }),
    ...(position.width > 0 && widthMode !== "none"
      ? widthMode === "match"
        ? { width: `${position.width}px` }
        : { minWidth: `${position.width}px` }
      : {}),
    ...(constrainHeight
      ? {
          maxHeight: `${
            maxHeightCap === undefined
              ? position.maxHeight
              : Math.min(maxHeightCap, position.maxHeight)
          }px`,
        }
      : {}),
  };
}

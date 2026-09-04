/**
 * Geometry for second-level (submenu) panels opened from a row of a
 * first-level menu.
 *
 * Two steps, deliberately split so both are pure and testable:
 *
 * 1. `getSubmenuAnchor` runs when the row opens the submenu, from the row's
 *    rect and the parent panel's rect. It picks the side (right of the parent
 *    unless the viewport has no room, then left) and the preferred top.
 * 2. `clampSubmenuTop` runs after the submenu has rendered and its real height
 *    is known. It keeps the panel inside both the viewport and the parent
 *    menu's vertical span, and — when the submenu is taller than that span —
 *    aligns it to whichever edge the parent menu grew from.
 */
import { DROPDOWN_PANEL } from "./tokens";

/** The subset of `DOMRect` this module reads. */
export interface SubmenuRect {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export interface SubmenuAnchor {
  left: number;
  /** The parent menu opened upward, so a tall submenu bottom-aligns with it. */
  opensUpward: boolean;
  parentBottom: number;
  parentTop: number;
  top: number;
}

export interface SubmenuAnchorInput {
  triggerRect: SubmenuRect;
  /** Null when the parent panel is not mounted yet; the viewport bounds it. */
  parentRect: SubmenuRect | null;
  submenuWidth: number;
  viewportWidth: number;
  viewportHeight: number;
  opensUpward: boolean;
}

export function getSubmenuAnchor({
  triggerRect,
  parentRect,
  submenuWidth,
  viewportWidth,
  viewportHeight,
  opensUpward,
}: SubmenuAnchorInput): SubmenuAnchor {
  // Rows are inset by the panel's border/padding. Anchor horizontally to the
  // outer panel so all callers get the same visible gap, regardless of inset.
  const horizontalBounds = parentRect ?? triggerRect;
  const rightSideLeft = horizontalBounds.right + DROPDOWN_PANEL.submenuGap;
  const left =
    rightSideLeft + submenuWidth > viewportWidth
      ? horizontalBounds.left - submenuWidth - DROPDOWN_PANEL.submenuGap
      : rightSideLeft;

  return {
    left,
    opensUpward,
    parentTop: parentRect?.top ?? DROPDOWN_PANEL.viewportPadding,
    parentBottom:
      parentRect?.bottom ?? viewportHeight - DROPDOWN_PANEL.viewportPadding,
    // Pull up by the panel padding so the first submenu row lines up with the
    // row that opened it rather than sitting one padding step lower.
    top: Math.max(
      DROPDOWN_PANEL.viewportPadding,
      triggerRect.top - DROPDOWN_PANEL.padding
    ),
  };
}

export interface SubmenuTopInput {
  anchor: SubmenuAnchor;
  submenuHeight: number;
  viewportHeight: number;
}

export function clampSubmenuTop({
  anchor,
  submenuHeight,
  viewportHeight,
}: SubmenuTopInput): number {
  const viewportTop = DROPDOWN_PANEL.viewportPadding;
  const viewportBottom = viewportHeight - DROPDOWN_PANEL.viewportPadding;
  const boundaryTop = Math.max(viewportTop, anchor.parentTop);
  const boundaryBottom = Math.min(viewportBottom, anchor.parentBottom);
  const boundaryHeight = boundaryBottom - boundaryTop;
  const boundaryAlignedTop = anchor.opensUpward
    ? boundaryBottom - submenuHeight
    : boundaryTop;
  const parentClampedTop =
    submenuHeight > boundaryHeight
      ? boundaryAlignedTop
      : Math.min(
          Math.max(anchor.top, boundaryTop),
          boundaryBottom - submenuHeight
        );
  const viewportMaxTop = Math.max(
    DROPDOWN_PANEL.viewportPadding,
    viewportHeight - submenuHeight - DROPDOWN_PANEL.viewportPadding
  );

  return Math.max(viewportTop, Math.min(parentClampedTop, viewportMaxTop));
}

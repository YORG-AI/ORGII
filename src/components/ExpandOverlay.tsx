/**
 * ExpandOverlay
 *
 * Reusable gradient-fade + hover-visible pill for expand/collapse.
 *
 * **Collapsed**: absolute gradient overlay at the clipped edge of the
 * content area, with a centered pill that appears on hover (parent needs
 * Tailwind `group`). The clipped edge defaults to the bottom; use `top`
 * for bottom-aligned previews whose hidden content is above the viewport.
 *
 * **Expanded**: a `position: sticky` bar at the bottom with a short
 * bottom-to-top fade above the pill (no fixed min-height — avoids a dead
 * gap under long content).
 *
 * Requirements on the parent element:
 *   - `position: relative` (for collapsed absolute overlay)
 *   - Tailwind `group/expand` class (scoped hover detection — avoids
 *     leaking through unrelated `group` ancestors)
 *   - For expanded sticky to work, the parent must be the scroll
 *     container (e.g. `maxHeight: 60vh; overflowY: auto`).
 */
import React from "react";

import FloatingExpandPill from "./FloatingExpandPill";

interface ExpandOverlayProps {
  isExpanded: boolean;
  onToggle: (e: React.MouseEvent) => void;
  collapsedLabel?: string;
  expandedLabel?: string;
  collapsedFadeHeightClass?: string;
  collapsedFadeEdge?: "top" | "bottom";
  collapsedOffsetPx?: number;
  showLabel?: boolean;
  alwaysShowControl?: boolean;
  /** Tailwind `from-*` class for the gradient background (default: "from-fill-2") */
  fadeFrom?: string;
}

const ExpandOverlay: React.FC<ExpandOverlayProps> = ({
  isExpanded,
  onToggle,
  collapsedLabel,
  expandedLabel,
  collapsedFadeHeightClass = "h-14",
  collapsedFadeEdge = "bottom",
  collapsedOffsetPx = 0,
  showLabel = false,
  alwaysShowControl = false,
  fadeFrom = "from-fill-2",
}) => {
  const isTopFade = collapsedFadeEdge === "top";
  const collapsedOffsetStyle = isTopFade
    ? { transform: `translateY(${collapsedOffsetPx}px)` }
    : undefined;

  if (!isExpanded) {
    return (
      <>
        <div
          className={`pointer-events-none absolute left-0 right-0 z-10 ${isTopFade ? "top-0 bg-gradient-to-b" : "bottom-0 bg-gradient-to-t"} ${collapsedFadeHeightClass} ${fadeFrom} to-transparent`}
          style={collapsedOffsetStyle}
        />
        <div
          className={`absolute left-0 right-0 z-20 flex justify-center transition-opacity ${alwaysShowControl ? "opacity-100" : "opacity-0 group-focus-within/expand:opacity-100 group-hover/expand:opacity-100"} ${isTopFade ? "top-0 pt-1" : "bottom-0 pb-1"}`}
          style={collapsedOffsetStyle}
        >
          <FloatingExpandPill
            expanded={false}
            onClick={onToggle}
            label={collapsedLabel}
            showLabel={showLabel}
          />
        </div>
      </>
    );
  }

  return (
    <div
      className={`sticky -bottom-2 z-10 flex flex-col items-center bg-gradient-to-t ${fadeFrom} to-transparent pb-3 pt-3 opacity-75`}
    >
      <FloatingExpandPill
        expanded
        onClick={onToggle}
        label={expandedLabel}
        showLabel={showLabel}
      />
    </div>
  );
};

export default React.memo(ExpandOverlay);

import type { ReactNode } from "react";
import React, { memo } from "react";

import Tooltip, { type TooltipProps } from "@src/components/Tooltip";

export interface StatusBarTooltipProps {
  /** Action label, e.g. "Switch branch". */
  label: ReactNode;
  /**
   * Placement. Defaults to `"top"` because the status bar sits near the
   * bottom of the station, so tooltips open upward.
   */
  position?: TooltipProps["position"];
  /** Force-hide, e.g. while the item's own dropdown is open. */
  disabled?: boolean;
  children: ReactNode;
}

/**
 * Styled hover tooltip for status-bar switcher buttons. Wraps the app
 * {@link Tooltip} with the workstation panel look (framed panel, upward
 * placement, smart flip) so status-bar items use our tooltip surface instead
 * of the browser's native `title` tooltip.
 *
 * The single child must forward a `ref` and hover/focus handlers — pass a
 * `StatusBarButton` (which does) rather than a raw element that drops them.
 */
export const StatusBarTooltip: React.FC<StatusBarTooltipProps> = memo(
  ({ label, position = "top", disabled = false, children }) => (
    <Tooltip
      content={label}
      position={position}
      mouseEnterDelay={200}
      framedPanel
      smartPlacement
      disabled={disabled}
    >
      {children}
    </Tooltip>
  )
);

StatusBarTooltip.displayName = "StatusBarTooltip";

export default StatusBarTooltip;

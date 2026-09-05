/**
 * CiCheckStateIcon
 *
 * The one glyph vocabulary for a CI verdict — green tick, red cross, spinning
 * amber loader, muted slash — shared by every surface that renders check state
 * (the Checks tab, the merge-status rail, and its checks panel) so a passing
 * check never reads differently between them.
 */
import React from "react";

import {
  CancelCircleIcon,
  CheckmarkCircle01Icon,
  CircleSlashIcon,
  HugeiconsIcon,
  Loading03Icon,
} from "@src/icons";
import type { CiCheckState } from "@src/services/git/ciCheckState";

const STATE_ICONS = {
  success: {
    icon: CheckmarkCircle01Icon,
    dataIcon: "check-circle-2",
    className: "text-success-6",
  },
  failure: {
    icon: CancelCircleIcon,
    dataIcon: "xcircle",
    className: "text-danger-6",
  },
  pending: {
    icon: Loading03Icon,
    dataIcon: "loader",
    className: "animate-spin text-warning-6",
  },
  neutral: {
    icon: CircleSlashIcon,
    dataIcon: "circle-slash",
    className: "text-text-3",
  },
} as const;

export interface CiCheckStateIconProps {
  state: CiCheckState;
  size?: number;
  className?: string;
}

export function CiCheckStateIcon({
  state,
  size = 15,
  className = "",
}: CiCheckStateIconProps): React.ReactNode {
  const { icon, dataIcon, className: toneClass } = STATE_ICONS[state];
  return (
    <HugeiconsIcon
      icon={icon}
      data-icon={dataIcon}
      size={size}
      strokeWidth={1.9}
      className={`${toneClass} ${className}`.trim()}
      aria-hidden
    />
  );
}

export default CiCheckStateIcon;

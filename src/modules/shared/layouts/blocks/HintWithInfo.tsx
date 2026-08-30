/**
 * HintWithInfo Component
 *
 * Reusable info icon with tooltip for explaining commands, options, or hints.
 * Used in LINT (install commands), Git settings (pull strategies), etc.
 */
import React, { memo } from "react";

import Tooltip from "@src/components/Tooltip";
import { HugeiconsIcon, InformationCircleIcon } from "@src/icons";

export interface HintWithInfoProps {
  /** Tooltip content (plain text or React node) */
  content: React.ReactNode;
  /** Tooltip position */
  position?: "top" | "bottom" | "left" | "right";
  /** Icon size in pixels */
  size?: number;
  /** Additional class name for the trigger */
  className?: string;
}

export const HintWithInfo: React.FC<HintWithInfoProps> = memo(
  ({ content, position = "left", size = 16, className = "" }) => (
    <Tooltip
      content={content}
      position={position}
      style={
        position === "left" ? { transform: "translateX(-2px)" } : undefined
      }
    >
      <span
        className={`flex cursor-help items-center p-1 ${className}`}
        role="img"
        aria-label="More information"
      >
        <HugeiconsIcon
          icon={InformationCircleIcon}
          data-icon="info"
          size={size}
          className="text-text-3"
        />
      </span>
    </Tooltip>
  )
);

HintWithInfo.displayName = "HintWithInfo";

export default HintWithInfo;

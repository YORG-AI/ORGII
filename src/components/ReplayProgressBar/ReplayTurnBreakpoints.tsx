import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import Tooltip from "@src/components/Tooltip";

import type { ReplayProgressSegment } from "./types";

export interface ReplayTurnBreakpointsProps {
  segments: readonly ReplayProgressSegment[];
  onSegmentClick?: (segment: ReplayProgressSegment) => void;
}

const ReplayTurnBreakpoints: React.FC<ReplayTurnBreakpointsProps> = memo(
  ({ segments, onSegmentClick }) => {
    const { t } = useTranslation("sessions");

    const handleClick = useCallback(
      (segment: ReplayProgressSegment) => (event: React.MouseEvent) => {
        event.stopPropagation();
        onSegmentClick?.(segment);
      },
      [onSegmentClick]
    );

    if (segments.length <= 1) return null;

    return (
      <div
        className="replay-turn-breakpoints"
        role="group"
        aria-label={t("tools.replay.turnBreakpointsAria")}
      >
        {segments.slice(1).map((segment) => (
          <Tooltip
            key={segment.id}
            content={segment.tooltip}
            position="bottom"
            mouseEnterDelay={80}
            smartPlacement
          >
            <button
              type="button"
              data-testid="replay-turn-breakpoint"
              data-active={segment.isActive ? "true" : undefined}
              aria-current={segment.isActive ? "step" : undefined}
              aria-label={segment.ariaLabel}
              className="replay-turn-breakpoints__marker"
              style={{ left: `${segment.leftPercent}%` }}
              onClick={handleClick(segment)}
            >
              <span
                className="replay-turn-breakpoints__dot"
                aria-hidden="true"
              />
            </button>
          </Tooltip>
        ))}
      </div>
    );
  }
);

ReplayTurnBreakpoints.displayName = "ReplayTurnBreakpoints";

export default ReplayTurnBreakpoints;

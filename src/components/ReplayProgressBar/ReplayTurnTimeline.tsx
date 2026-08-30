import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import Tooltip from "@src/components/Tooltip";

import type { ReplayProgressSegment } from "./types";

export interface ReplayTurnTimelineProps {
  segments: readonly ReplayProgressSegment[];
  onSegmentClick?: (segment: ReplayProgressSegment) => void;
}

const ReplayTurnTimeline: React.FC<ReplayTurnTimelineProps> = memo(
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
      <div className="replay-turn-timeline">
        <div
          className="replay-turn-timeline__track mx-2"
          role="list"
          aria-label={t("tools.replay.turnTrackAria")}
        >
          {segments.map((segment) => (
            <Tooltip
              key={segment.id}
              content={segment.tooltip}
              position="bottom"
              mouseEnterDelay={80}
            >
              <button
                type="button"
                role="listitem"
                data-testid="replay-turn-segment"
                data-active={segment.isActive ? "true" : undefined}
                data-color-index={segment.colorIndex % 6}
                aria-label={segment.ariaLabel}
                className="replay-turn-timeline__segment"
                style={{
                  left: `${segment.leftPercent}%`,
                  width: `${segment.widthPercent}%`,
                }}
                onClick={handleClick(segment)}
              />
            </Tooltip>
          ))}
        </div>
      </div>
    );
  }
);

ReplayTurnTimeline.displayName = "ReplayTurnTimeline";

export default ReplayTurnTimeline;

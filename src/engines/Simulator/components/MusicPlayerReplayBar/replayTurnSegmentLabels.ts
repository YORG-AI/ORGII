import type { TFunction } from "i18next";

import type { ReplayProgressSegment } from "@src/components/ReplayProgressBar/types";
import { getTurnTimingLabels } from "@src/engines/ChatPanel/ChatHistory/utils/turnTimingFormatting";
import type { ReplayTurnSegment } from "@src/engines/SessionCore/replay/replayTurnSegments";

export function formatReplayTurnSegmentLabels(
  segment: ReplayTurnSegment,
  t: TFunction<"sessions">
): Pick<ReplayProgressSegment, "tooltip" | "ariaLabel"> {
  const timing = getTurnTimingLabels(
    segment.durationMs,
    segment.startMs,
    segment.endMs
  );
  const tooltip = timing.showRange
    ? t("tools.replay.segmentTooltip", {
        number: segment.turnNumber,
        duration: timing.duration,
        start: timing.startClock,
        end: timing.endClock,
      })
    : t("tools.replay.segmentTooltipNoRange", {
        number: segment.turnNumber,
        duration: timing.duration,
      });

  return {
    tooltip,
    ariaLabel: t("tools.replay.segmentAria", { number: segment.turnNumber }),
  };
}

export function toReplayProgressSegments(
  segments: readonly ReplayTurnSegment[],
  activeTurnId: string | null,
  t: TFunction<"sessions">
): ReplayProgressSegment[] {
  return segments.map((segment) => ({
    id: segment.turnId,
    turnNumber: segment.turnNumber,
    leftPercent: segment.leftPercent,
    widthPercent: segment.widthPercent,
    colorIndex: segment.colorIndex,
    isActive: activeTurnId === segment.turnId,
    ...formatReplayTurnSegmentLabels(segment, t),
  }));
}

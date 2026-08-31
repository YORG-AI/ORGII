/**
 * MusicPlayerReplayBar
 *
 * Thin Simulator-side wrapper around the generic `ReplayProgressBar`.
 * Owns the index↔slider-value math and the drag-debounce ergonomics;
 * defers all visual rendering (rail, track, edge caps, follow-mode
 * playhead hiding) to the shared component so Kanban and Simulator
 * stay pixel-identical without code duplication.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import ReplayProgressBar from "@src/components/ReplayProgressBar";
import type { ReplayProgressSegment } from "@src/components/ReplayProgressBar/types";
import { REPLAY_CONFIG } from "@src/config/workspace/replayConfig";
import {
  currentSimulatorEventIndexAtom,
  effectiveSimulatorEventIdsAtom,
  navigateToSimulatorEventByIndexAtom,
  replayModeAtom,
  simulatorEventCountAtom,
  simulatorEventPreviewByIdAtom,
} from "@src/engines/SessionCore";
import {
  buildReplayTurnSegments,
  findActiveReplayTurnSegment,
} from "@src/engines/SessionCore/replay/replayTurnSegments";

import { toReplayProgressSegments } from "./replayTurnSegmentLabels";

const MusicPlayerReplayBar: React.FC = memo(() => {
  const { t } = useTranslation("sessions");
  const eventIds = useAtomValue(effectiveSimulatorEventIdsAtom);
  const previewById = useAtomValue(simulatorEventPreviewByIdAtom);
  const eventCount = useAtomValue(simulatorEventCountAtom);
  const currentIndex = useAtomValue(currentSimulatorEventIndexAtom);
  const navigateToIndex = useSetAtom(navigateToSimulatorEventByIndexAtom);
  const [replayMode, setReplayMode] = useAtom(replayModeAtom);

  const [isDragging, setIsDragging] = useState(false);
  const [dragValue, setDragValue] = useState(0);
  const dragUpdateTimerRef = useRef<NodeJS.Timeout | null>(null);

  const sliderValue = useMemo(() => {
    if (eventCount <= 1) return 0;
    const safeIndex = Math.max(0, currentIndex);
    return (safeIndex / (eventCount - 1)) * REPLAY_CONFIG.MAX_VALUE;
  }, [currentIndex, eventCount]);

  const displayValue = isDragging ? dragValue : sliderValue;

  const sliderValueToIndex = useCallback(
    (value: number): number => {
      if (eventCount <= 1) return 0;
      return Math.round((value / REPLAY_CONFIG.MAX_VALUE) * (eventCount - 1));
    },
    [eventCount]
  );

  const handleValueChange = useCallback(
    (value: number | number[]) => {
      const numVal = Array.isArray(value) ? value[0] : value;
      setIsDragging(true);
      setDragValue(numVal);

      if (dragUpdateTimerRef.current) {
        clearTimeout(dragUpdateTimerRef.current);
      }
      dragUpdateTimerRef.current = setTimeout(() => {
        const targetIndex = sliderValueToIndex(numVal);
        navigateToIndex(targetIndex);
      }, 16);
    },
    [sliderValueToIndex, navigateToIndex]
  );

  // Drop-at-end snaps back to follow mode so new events auto-advance.
  // Otherwise `navigateToSimulatorEventByIndexAtom` already sets the mode
  // to "replay" (free browsing).
  const handleValueCommit = useCallback(
    (value: number | number[]) => {
      const numVal = Array.isArray(value) ? value[0] : value;

      if (dragUpdateTimerRef.current) {
        clearTimeout(dragUpdateTimerRef.current);
        dragUpdateTimerRef.current = null;
      }

      const targetIndex = sliderValueToIndex(numVal);
      navigateToIndex(targetIndex);

      if (eventCount > 0 && targetIndex >= eventCount - 1) {
        setReplayMode("follow");
      }

      setIsDragging(false);
    },
    [sliderValueToIndex, navigateToIndex, setReplayMode, eventCount]
  );

  React.useEffect(() => {
    return () => {
      if (dragUpdateTimerRef.current) {
        clearTimeout(dragUpdateTimerRef.current);
      }
    };
  }, []);

  const turnSegments = useMemo(
    () =>
      buildReplayTurnSegments({
        eventIds,
        previewById,
        maxValue: REPLAY_CONFIG.MAX_VALUE,
      }),
    [eventIds, previewById]
  );

  const segmentViews = useMemo(
    () => toReplayProgressSegments(turnSegments, null, t),
    [t, turnSegments]
  );

  const activeTurn = useMemo(
    () => findActiveReplayTurnSegment(turnSegments, currentIndex),
    [turnSegments, currentIndex]
  );

  const segments = useMemo(
    () =>
      segmentViews.map((segment) => ({
        ...segment,
        isActive: segment.id === activeTurn?.turnId,
      })),
    [activeTurn?.turnId, segmentViews]
  );

  const handleSegmentClick = useCallback(
    (segment: ReplayProgressSegment) => {
      const turnSegment = turnSegments.find(
        (candidate) => candidate.turnId === segment.id
      );
      if (!turnSegment) return;
      navigateToIndex(turnSegment.startIndex);
    },
    [navigateToIndex, turnSegments]
  );

  return (
    <ReplayProgressBar
      value={displayValue}
      max={REPLAY_CONFIG.MAX_VALUE}
      onValueChange={handleValueChange}
      onValueCommit={handleValueCommit}
      isFollowMode={replayMode === "follow"}
      disabled={eventCount === 0}
      segments={segments}
      onSegmentClick={handleSegmentClick}
    />
  );
});

MusicPlayerReplayBar.displayName = "MusicPlayerReplayBar";

export default MusicPlayerReplayBar;

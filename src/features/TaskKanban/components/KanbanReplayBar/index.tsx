/**
 * KanbanReplayBar
 *
 * Thin Kanban-side wrapper around the generic `ReplayProgressBar`.
 * Mirrors the Simulator replay bar's index-based scrubbing model: the
 * caller maps the current replay event index into the shared slider
 * domain, debounces drag updates, and lets the navigation atom decide
 * whether the board is parked in replay mode or snapped back to follow.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import ReplayProgressBar from "@src/components/ReplayProgressBar";
import { REPLAY_CONFIG } from "@src/config/workspace/replayConfig";
import {
  currentKanbanReplayEventIndexAtom,
  kanbanReplayEventCountAtom,
  kanbanReplayModeAtom,
  navigateKanbanCursorByIndexAtom,
} from "@src/store/ui/kanbanReplayAtom";

const KanbanReplayBar: React.FC = memo(() => {
  const { t } = useTranslation("sessions");
  const eventCount = useAtomValue(kanbanReplayEventCountAtom);
  const currentIndex = useAtomValue(currentKanbanReplayEventIndexAtom);
  const navigateToIndex = useSetAtom(navigateKanbanCursorByIndexAtom);
  const [replayMode, setReplayMode] = useAtom(kanbanReplayModeAtom);

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

  const handleOnChange = useCallback(
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

  const handleOnAfterChange = useCallback(
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

  return (
    <ReplayProgressBar
      value={displayValue}
      max={REPLAY_CONFIG.MAX_VALUE}
      onChange={handleOnChange}
      onAfterChange={handleOnAfterChange}
      isFollowMode={replayMode === "follow"}
      disabled={eventCount === 0}
      ariaLabel={t("kanban.replayBarAriaLabel")}
    />
  );
});

KanbanReplayBar.displayName = "KanbanReplayBar";

export default KanbanReplayBar;

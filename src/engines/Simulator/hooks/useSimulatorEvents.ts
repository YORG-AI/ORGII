/**
 * useSimulatorEvents Hook
 *
 * Main hook for activity simulator event management.
 * Composes sub-hooks for modular functionality.
 */
import dayjs from "dayjs";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo } from "react";

import { REPLAY_CONFIG } from "@src/config/workspace/replayConfig";
import {
  createdAtByIdAtom,
  currentEventAtom,
  currentEventIdAtom,
  effectiveSimulatorEventIdsAtom,
  eventIndexAtom,
  loadStatusAtom,
  replayBarValueAtom,
  replayModeAtom,
  replayTimeRangeAtom,
  specsAtom,
} from "@src/engines/SessionCore";
import type { SessionEvent } from "@src/engines/SessionCore";

import {
  DEFAULT_SIMULATOR_OPTIONS,
  TimeRangeInfo,
  UseSimulatorEventsOptions,
  UseSimulatorEventsReturn,
} from "./types";
import { useEventNavigation } from "./useEventNavigation";
import { useReplayMode } from "./useReplayMode";

export function useSimulatorEvents(
  options: UseSimulatorEventsOptions = {}
): UseSimulatorEventsReturn {
  const opts = { ...DEFAULT_SIMULATOR_OPTIONS, ...options };

  const effectiveEventIds = useAtomValue(effectiveSimulatorEventIdsAtom);
  const eventById = useAtomValue(eventIndexAtom);
  const createdAtById = useAtomValue(createdAtByIdAtom);
  const specs = useAtomValue(specsAtom);
  const loadStatus = useAtomValue(loadStatusAtom);
  const currentEvent = useAtomValue(currentEventAtom);
  const setCurrentEventId = useSetAtom(currentEventIdAtom);
  const timeRange = useAtomValue(replayTimeRangeAtom);
  const replayBarValue = useAtomValue(replayBarValueAtom);
  const setReplayBarValue = useSetAtom(replayBarValueAtom);
  const replayMode = useAtomValue(replayModeAtom);
  const setReplayTimeRange = useSetAtom(replayTimeRangeAtom);

  const setCurrentEvent = useCallback(
    (event: SessionEvent | null) => {
      setCurrentEventId(event?.id ?? null);
    },
    [setCurrentEventId]
  );

  useReplayMode({ replayBarValue });

  const timeRangeInfo = useMemo<TimeRangeInfo>(() => {
    const startDate = dayjs(timeRange.start);
    const endDate = dayjs(timeRange.end);
    const isValid =
      startDate.isValid() && endDate.isValid() && !startDate.isSame(endDate);

    return {
      isValid,
      startMs: startDate.valueOf(),
      endMs: endDate.valueOf(),
      timeRangeMs: endDate.valueOf() - startDate.valueOf(),
    };
  }, [timeRange]);

  const replayValue = Array.isArray(replayBarValue)
    ? replayBarValue[0]
    : replayBarValue;

  const simulatorCurrentEventId = useMemo(() => {
    if (effectiveEventIds.length === 0) return null;

    if (replayMode === "follow") {
      return effectiveEventIds[effectiveEventIds.length - 1];
    }

    if (currentEvent && effectiveEventIds.includes(currentEvent.id)) {
      return currentEvent.id;
    }

    return effectiveEventIds[0] ?? null;
  }, [effectiveEventIds, replayMode, currentEvent]);

  const simulatorCurrentEvent = simulatorCurrentEventId
    ? (eventById.get(simulatorCurrentEventId) ?? null)
    : null;

  const currentEventIndex = useMemo(() => {
    if (!simulatorCurrentEventId) return -1;
    return effectiveEventIds.indexOf(simulatorCurrentEventId);
  }, [simulatorCurrentEventId, effectiveEventIds]);

  const hasRealData = effectiveEventIds.length > 0;

  const getCurTime = useCallback(
    (val: number): dayjs.Dayjs => {
      if (timeRangeInfo.isValid) {
        const currentTimeMs =
          timeRangeInfo.startMs +
          (val / REPLAY_CONFIG.MAX_VALUE) * timeRangeInfo.timeRangeMs;
        return dayjs(currentTimeMs);
      }
      return dayjs();
    },
    [timeRangeInfo]
  );

  const replayTime = useMemo(() => {
    return getCurTime(replayValue);
  }, [getCurTime, replayValue]);

  const navigation = useEventNavigation({
    eventIds: effectiveEventIds,
    eventById,
    currentEvent: simulatorCurrentEvent,
    currentEventIndex,
    timeRangeInfo,
    setContextCurEvent: setCurrentEvent,
    setReplayBarValue,
    onEventChange: opts.onEventChange,
  });

  useEffect(() => {
    if (
      simulatorCurrentEvent &&
      simulatorCurrentEvent.id !== currentEvent?.id
    ) {
      setCurrentEvent(simulatorCurrentEvent);
    }
  }, [simulatorCurrentEvent, currentEvent, setCurrentEvent]);

  useEffect(() => {
    if (effectiveEventIds.length === 0) return;

    const firstEventId = effectiveEventIds[0];
    const lastEventId = effectiveEventIds[effectiveEventIds.length - 1];
    const firstCreatedAt = createdAtById[firstEventId];
    const lastCreatedAt = createdAtById[lastEventId];
    if (!firstCreatedAt || !lastCreatedAt) return;

    const firstEventDate = dayjs(firstCreatedAt);
    const lastEventDate = dayjs(lastCreatedAt);

    if (!firstEventDate.isValid() || !lastEventDate.isValid()) return;

    if (!timeRangeInfo.isValid) {
      const newTimeRange = {
        start: firstCreatedAt,
        end: lastCreatedAt,
      };

      if (firstCreatedAt === lastCreatedAt) {
        newTimeRange.end = lastEventDate.add(1, "minute").toISOString();
      }

      setReplayTimeRange(newTimeRange);
      setReplayBarValue(REPLAY_CONFIG.MAX_VALUE);
    } else {
      const firstEventMs = firstEventDate.valueOf();
      const lastEventMs = lastEventDate.valueOf();

      let needsUpdate = false;
      const newTimeRange = { ...timeRange };

      if (firstEventMs < timeRangeInfo.startMs) {
        newTimeRange.start = firstCreatedAt;
        needsUpdate = true;
      }
      if (lastEventMs > timeRangeInfo.endMs) {
        newTimeRange.end = lastCreatedAt;
        needsUpdate = true;
      }

      if (needsUpdate) {
        setReplayTimeRange(newTimeRange);
      }
    }
  }, [
    effectiveEventIds,
    createdAtById,
    timeRangeInfo.isValid,
    timeRangeInfo.startMs,
    timeRangeInfo.endMs,
    timeRange,
    setReplayTimeRange,
    setReplayBarValue,
  ]);

  return {
    eventIds: effectiveEventIds,
    specs,
    currentEvent: simulatorCurrentEvent,
    currentEventIndex,
    setCurrentEventById: navigation.setCurrentEventById,
    setCurrentEventByIndex: navigation.setCurrentEventByIndex,
    replayValue,
    setReplayValue: navigation.setReplayValue,
    replayTime,
    timeRange,
    isValidTimeRange: timeRangeInfo.isValid,
    goToStart: navigation.goToStart,
    goToEnd: navigation.goToEnd,
    goToNext: navigation.goToNext,
    goToPrevious: navigation.goToPrevious,
    loading: loadStatus === "loading" || loadStatus === "idle",
    hasRealData,
    cacheStatus: "idle",
  };
}

export default useSimulatorEvents;

export type {
  UseSimulatorEventsOptions,
  UseSimulatorEventsReturn,
} from "./types";

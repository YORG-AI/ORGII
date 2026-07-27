/**
 * useSessionStore Hook
 *
 * Primary hook for session state management.
 * Provides a clean API for components to interact with the session store.
 *
 * This replaces direct usage of:
 * - useStepContext (for events)
 * - useReplayContext (for replay state)
 * - useChatContext.chatHistory (for chat events)
 *
 * Usage:
 * ```tsx
 * const {
 *   // Events
 *   events,
 *   chatEvents,
 *   simulatorEvents,
 *   currentEvent,
 *
 *   // Navigation
 *   navigateToEvent,
 *   navigateNext,
 *   navigatePrev,
 *   goLive,
 *
 *   // Replay
 *   replayMode,
 *   replayBarValue,
 *   setReplayBarValue,
 *
 *   // Session
 *   sessionId,
 *   loadStatus,
 * } = useSessionStore();
 * ```
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { ROUTES, isWorkbenchPath } from "@src/config/routes";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";

import {
  appendEventsAtom,
  clearSessionAtom,
  currentEventAtom,
  currentEventIdAtom,
  currentEventIndexAtom,
  eventIndexAtom,
  eventsAtom,
  goLiveAtom,
  hasMoreEventsAtom,
  isFromCacheAtom,
  isLoadingMoreAtom,
  lastFetchedAtom,
  loadSessionAtom,
  loadStatusAtom,
  navigateNextAtom,
  navigatePrevAtom,
  navigateToEventAtom,
  replayBarValueAtom,
  replayModeAtom,
  replayTimeRangeAtom,
  replayTimeRangeValidAtom,
  sessionIdAtom,
  sortedEventsAtom,
  specsAtom,
  updateEventAtom,
} from "../core/atoms";
import type { SessionSpec } from "../core/types";
import type {
  ReplayMode,
  ReplayTimeRange,
  SessionEvent,
  SessionLoadStatus,
} from "../core/types";
import { chatEventsAtom } from "../derived/chatEvents";
import { simulatorEventsAtom } from "../derived/simulatorEvents";

// ============================================
// Main Hook
// ============================================

export interface UseSessionStoreReturn {
  // Events
  events: SessionEvent[];
  sortedEvents: SessionEvent[];
  chatEvents: SessionEvent[];
  simulatorEvents: SessionEvent[];
  eventIndex: Map<string, SessionEvent>;

  // Current event
  currentEvent: SessionEvent | null;
  currentEventId: string | null;
  currentEventIndex: number;

  // Navigation
  navigateToEvent: (eventId: string) => void;
  navigateNext: () => void;
  navigatePrev: () => void;
  goLive: () => void;

  // Replay state
  replayMode: ReplayMode;
  setReplayMode: (mode: ReplayMode) => void;
  replayBarValue: number;
  setReplayBarValue: (value: number) => void;
  replayTimeRange: ReplayTimeRange;
  isReplayTimeRangeValid: boolean;

  // Session metadata
  sessionId: string | null;
  loadStatus: SessionLoadStatus;

  // Cache state
  isFromCache: boolean;
  lastFetched: number | null;

  // Pagination
  hasMoreEvents: boolean;
  isLoadingMore: boolean;

  // Specs
  specs: SessionSpec[];

  // Actions
  loadSession: (payload: {
    sessionId: string;
    events: SessionEvent[];
    specs?: SessionSpec[];
    isFromCache?: boolean;
  }) => void;
  appendEvents: (events: SessionEvent[]) => void;
  updateEvent: (event: SessionEvent) => void;
  clearSession: () => void;
}

export function useSessionStore(): UseSessionStoreReturn {
  // Read atoms
  const events = useAtomValue(eventsAtom);
  const sortedEvents = useAtomValue(sortedEventsAtom);
  const chatEvents = useAtomValue(chatEventsAtom);
  const simulatorEvents = useAtomValue(simulatorEventsAtom);
  const eventIndex = useAtomValue(eventIndexAtom);

  const currentEvent = useAtomValue(currentEventAtom);
  const currentEventId = useAtomValue(currentEventIdAtom);
  const currentEventIndex = useAtomValue(currentEventIndexAtom);

  const [replayMode, setReplayModeAtom] = useAtom(replayModeAtom);
  const [replayBarValue, setReplayBarValueAtom] = useAtom(replayBarValueAtom);
  const replayTimeRange = useAtomValue(replayTimeRangeAtom);
  const isReplayTimeRangeValid = useAtomValue(replayTimeRangeValidAtom);

  const sessionId = useAtomValue(sessionIdAtom);
  const loadStatus = useAtomValue(loadStatusAtom);

  const isFromCache = useAtomValue(isFromCacheAtom);
  const lastFetched = useAtomValue(lastFetchedAtom);

  const hasMoreEvents = useAtomValue(hasMoreEventsAtom);
  const isLoadingMore = useAtomValue(isLoadingMoreAtom);

  const specs = useAtomValue(specsAtom);

  // Action atoms (useSetAtom returns stable references — no useCallback needed)
  const navigateToEvent = useSetAtom(navigateToEventAtom);
  const navigateNext = useSetAtom(navigateNextAtom);
  const navigatePrev = useSetAtom(navigatePrevAtom);
  const goLive = useSetAtom(goLiveAtom);
  const loadSession = useSetAtom(loadSessionAtom);
  const appendEvents = useSetAtom(appendEventsAtom);
  const updateEvent = useSetAtom(updateEventAtom);
  const clearSession = useSetAtom(clearSessionAtom);

  // useAtom setters are also stable references
  const setReplayMode = setReplayModeAtom;
  const setReplayBarValue = setReplayBarValueAtom;

  return useMemo(
    () => ({
      // Events
      events,
      sortedEvents,
      chatEvents,
      simulatorEvents,
      eventIndex,

      // Current event
      currentEvent,
      currentEventId,
      currentEventIndex,

      // Navigation
      navigateToEvent,
      navigateNext,
      navigatePrev,
      goLive,

      // Replay state
      replayMode,
      setReplayMode,
      replayBarValue,
      setReplayBarValue,
      replayTimeRange,
      isReplayTimeRangeValid,

      // Session metadata
      sessionId,
      loadStatus,

      // Cache state
      isFromCache,
      lastFetched,

      // Pagination
      hasMoreEvents,
      isLoadingMore,

      // Specs
      specs,

      // Actions
      loadSession,
      appendEvents,
      updateEvent,
      clearSession,
    }),
    [
      events,
      sortedEvents,
      chatEvents,
      simulatorEvents,
      eventIndex,
      currentEvent,
      currentEventId,
      currentEventIndex,
      navigateToEvent,
      navigateNext,
      navigatePrev,
      goLive,
      replayMode,
      setReplayMode,
      replayBarValue,
      setReplayBarValue,
      replayTimeRange,
      isReplayTimeRangeValid,
      sessionId,
      loadStatus,
      isFromCache,
      lastFetched,
      hasMoreEvents,
      isLoadingMore,
      specs,
      loadSession,
      appendEvents,
      updateEvent,
      clearSession,
    ]
  );
}

// ============================================
// Convenience Hooks (for specific use cases)
// ============================================

/**
 * Hook for just reading the current event.
 * Use when you only need to display the current event.
 */
export function useCurrentEvent(): SessionEvent | null {
  return useAtomValue(currentEventAtom);
}

/**
 * Hook for event navigation only.
 * Use in replay controls, chat event clicks, etc.
 */
export function useEventNavigation() {
  const navigate = useNavigate();
  const stationMode = useAtomValue(stationModeAtom);
  const setStationMode = useSetAtom(stationModeAtom);
  const navigateToEventAtomSetter = useSetAtom(navigateToEventAtom);
  const navigateNext = useSetAtom(navigateNextAtom);
  const navigatePrev = useSetAtom(navigatePrevAtom);
  const goLive = useSetAtom(goLiveAtom);

  const navigateToEvent = useCallback(
    (eventId: string) => {
      if (!isWorkbenchPath(window.location.pathname)) {
        navigate(ROUTES.workStation.base.path);
      }
      if (stationMode !== "agent-station") {
        setStationMode("agent-station");
      }
      navigateToEventAtomSetter(eventId);
    },
    [navigate, navigateToEventAtomSetter, setStationMode, stationMode]
  );

  return useMemo(
    () => ({
      navigateToEvent,
      navigateNext,
      navigatePrev,
      goLive,
    }),
    [navigateToEvent, navigateNext, navigatePrev, goLive]
  );
}

/**
 * Hook for replay bar state only.
 * Use in replay bar slider component.
 */
export function useReplayBar() {
  const [replayBarValue, setReplayBarValue] = useAtom(replayBarValueAtom);
  const replayTimeRange = useAtomValue(replayTimeRangeAtom);
  const isValid = useAtomValue(replayTimeRangeValidAtom);
  const [mode, setMode] = useAtom(replayModeAtom);

  return useMemo(
    () => ({
      value: replayBarValue,
      setValue: setReplayBarValue,
      timeRange: replayTimeRange,
      isValid,
      mode,
      setMode,
    }),
    [replayBarValue, setReplayBarValue, replayTimeRange, isValid, mode, setMode]
  );
}

/**
 * Hook for simulator events only.
 * Use in Simulator/ActivitySimulator components.
 */
export function useSimulatorEvents(): SessionEvent[] {
  return useAtomValue(simulatorEventsAtom);
}

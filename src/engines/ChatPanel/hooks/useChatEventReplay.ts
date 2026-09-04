/**
 * useChatEventReplay Hook
 *
 * Hook for replaying chat events in the simulator.
 * Uses session store atoms for cross-provider communication.
 *
 * NOTE: This hook does NOT switch simulator tabs - tabs are independent.
 * User manually controls which tab they're viewing.
 */
import dayjs from "dayjs";
import { useAtomValue } from "jotai";
import { useAtomCallback } from "jotai/utils";
import { useCallback } from "react";

import { REPLAY_CONFIG } from "@src/config/workspace/replayConfig";
import { useSessionTranscriptRuntime } from "@src/engines/ChatPanel/SessionTranscriptRuntimeContext";
import {
  currentEventIdAtom,
  eventIndexAtom,
  eventSecondaryLookupAtom,
  hasReplayableEventsAtom,
  replayBarValueAtom,
  replayModeAtom,
  replayTimeRangeAtom,
  sortedEventsAtom,
} from "@src/engines/SessionCore/core/atoms";
import {
  getPlanEventAliases,
  isPlanDisplayEvent,
  planAliasesContain,
} from "@src/engines/SessionCore/derived/planDisplayEvents";
import { resolveReplayEventLookup } from "@src/engines/SessionCore/replay/resolveReplayEventLookup";
import { createLogger } from "@src/hooks/logger";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import {
  simulatorFollowAppLockAtom,
  simulatorSelectedAppAtom,
  stationModeAtom,
} from "@src/store/ui/simulatorAtom";

const log = createLogger("ChatEventReplay");

export interface UseChatEventReplayReturn {
  /**
   * Locate and replay an event in the simulator by its event_id
   * @param eventId - The event_id (same as chunk_id from activity)
   */
  replayEventById: (eventId: string) => void;

  /**
   * Check if replay is available (has events loaded)
   */
  canReplay: boolean;
}

/**
 * Hook to replay chat events in the simulator.
 * Uses session store atoms directly - no legacy type conversions.
 *
 * IMPORTANT: Uses sortedEventsAtom (all events, pre-sorted) for lookup,
 * not chatEventsAtom, because some events (like submit_output) may be
 * filtered from chat but still need to be navigable in the simulator.
 */
export function useChatEventReplay(): UseChatEventReplayReturn {
  const runtime = useSessionTranscriptRuntime();
  // Only subscribe to a boolean flag that flips once (empty → non-empty).
  // Reading the live event/replay atoms here would re-render every subscriber
  // (every chat block via `useBlockLocate`) on each streamed event.
  const canReplayFromStore = useAtomValue(hasReplayableEventsAtom);

  // Read the live atoms lazily at click time via the jotai store instead of
  // subscribing. This keeps `replayEventById` stable and decouples chat block
  // re-renders from the streaming event list / replay time range.
  const replayEventViaStore = useAtomCallback(
    useCallback((get, set, eventId: string) => {
      if (!eventId) {
        log.warn("[ChatEventReplay] No event_id provided");
        return;
      }

      const sortedEvents = get(sortedEventsAtom);
      const eventIndex = get(eventIndexAtom);
      const eventSecondaryLookup = get(eventSecondaryLookupAtom);
      const timeRange = get(replayTimeRangeAtom);

      let event = resolveReplayEventLookup(sortedEvents, eventId);
      if (!event) {
        const lookupId = eventId.startsWith("group:stageoutput:")
          ? eventId.split(":").slice(3).join(":")
          : eventId;
        const secondaryEventId =
          eventSecondaryLookup.chunkIdToEventId.get(lookupId) ??
          eventSecondaryLookup.callIdToEventId.get(lookupId);
        event = secondaryEventId
          ? (eventIndex.get(secondaryEventId) ?? null)
          : null;
      }
      event ??=
        sortedEvents.find((candidate) => {
          if (!isPlanDisplayEvent(candidate)) return false;
          const lookupId = eventId.startsWith("group:stageoutput:")
            ? eventId.split(":").slice(3).join(":")
            : eventId;
          return planAliasesContain(getPlanEventAliases(candidate), lookupId);
        }) ?? null;

      if (!event) {
        log.warn(
          `[ChatEventReplay] Event not found: ${eventId}`,
          `| total events: ${sortedEvents.length}`
        );
        return;
      }
      const resolvedEventId = event.id;

      set(chatPanelMaximizedAtom, false);
      set(stationModeAtom, "agent-station");

      // Set event first — this is the primary navigation action.
      // Order matters: replayMode must be "replay" before currentEventId
      // so appendEventsAtom (which checks mode) doesn't auto-follow.
      set(replayModeAtom, "replay");
      set(currentEventIdAtom, resolvedEventId);

      // Clear user-forced app filters so locating a chat event follows the
      // clicked event across apps instead of staying restricted to a prior
      // dock selection or "This app" replay scope.
      //
      // The dock derives the active app from `currentEvent.functionName`
      // when `selectedApp` is null; user turns (`functionName === "user_message"`)
      // fall back to `AppType.CHANNELS` inside `useSimulatorContent` via
      // `event.source === "user"`.
      if (process.env.NODE_ENV === "development" && event.functionName) {
        log.debug(
          `[ChatEventReplay] Event ${resolvedEventId}: ${event.functionName} → follow dock`
        );
      }

      set(simulatorSelectedAppAtom, null);
      set(simulatorFollowAppLockAtom, null);

      // Compute bar position from the existing time range when valid,
      // otherwise derive it from sortedEvents (already O(1) sorted).
      const firstEvent = sortedEvents[0];
      const lastEvent = sortedEvents[sortedEvents.length - 1];
      if (!firstEvent || !lastEvent) return;

      let startTime = timeRange.start;
      let endTime = timeRange.end;
      const rangeValid = startTime && endTime && startTime !== endTime;

      if (!rangeValid) {
        startTime = firstEvent.createdAt;
        endTime = lastEvent.createdAt;
        if (startTime === endTime) {
          endTime = dayjs(endTime).add(1, "minute").toISOString();
        }
        set(replayTimeRangeAtom, { start: startTime, end: endTime });
      }

      const startMs = dayjs(startTime).valueOf();
      const endMs = dayjs(endTime).valueOf();
      const timeRangeMs = endMs - startMs;

      if (timeRangeMs > 0) {
        const eventMs = dayjs(event.createdAt).valueOf();
        const barValue =
          ((eventMs - startMs) / timeRangeMs) * REPLAY_CONFIG.MAX_VALUE;
        set(
          replayBarValueAtom,
          Math.max(0, Math.min(REPLAY_CONFIG.MAX_VALUE, barValue))
        );
      }
    }, [])
  );

  const replayEventById = useCallback(
    (eventId: string) => {
      if (runtime?.onNavigateToEvent) {
        runtime.onNavigateToEvent(eventId);
        return;
      }
      replayEventViaStore(eventId);
    },
    [replayEventViaStore, runtime]
  );

  return {
    replayEventById,
    canReplay: runtime?.onNavigateToEvent ? true : canReplayFromStore,
  };
}

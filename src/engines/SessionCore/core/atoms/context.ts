/**
 * Context-Aware Atoms
 *
 * Filtered views of events based on current thread selection.
 * Used by ActivitySimulator and ReplayControl for consistent behavior.
 */
import { atom } from "jotai";

import { REPLAY_CONFIG } from "@src/config/workspace/replayConfig";
import { selectedExecutionThreadAtom } from "@src/store/ui/sessionPaginationAtom";

import type { ReplayMode } from "../types";
import { eventIndexAtom, sortedEventsAtom } from "./events";
import {
  currentEventIdAtom,
  replayBarValueAtom,
  replayModeAtom,
  replayTimeRangeAtom,
} from "./replay";

// ============================================
// Effective Replay Context (Thread Aware)
// ============================================

/**
 * Events filtered by current thread selection.
 * - If thread selected: only that thread's events
 * - Otherwise: all events
 */
export const threadFilteredEventsAtom = atom((get) => {
  const events = get(sortedEventsAtom);
  const threadId = get(selectedExecutionThreadAtom);

  if (!threadId) return events;
  return events.filter((event) => event.threadId === threadId);
});
threadFilteredEventsAtom.debugLabel = "session/threadFilteredEvents";

/**
 * Effective events for replay — thread filter when a thread is selected,
 * otherwise all sorted events.
 */
export const effectiveEventsAtom = atom((get) => {
  return get(threadFilteredEventsAtom);
});
effectiveEventsAtom.debugLabel = "session/effectiveEvents";

/**
 * Effective time range based on current filter.
 * Automatically adjusts when a thread is selected.
 */
export const effectiveTimeRangeAtom = atom((get) => {
  const events = get(effectiveEventsAtom);
  const globalRange = get(replayTimeRangeAtom);

  // No events - use global range
  if (events.length === 0) {
    return globalRange;
  }

  const firstEvent = events[0];
  const lastEvent = events[events.length - 1];

  const start = firstEvent.createdAt;
  let end = lastEvent.createdAt;

  // Add buffer if same timestamp
  if (start === end) {
    end = new Date(new Date(end).getTime() + 60000).toISOString();
  }

  return { start, end };
});
effectiveTimeRangeAtom.debugLabel = "session/effectiveTimeRange";

/**
 * O(1) index lookup within effectiveEventsAtom.
 * Maps event ID → index in the context-filtered array.
 * Uses module-level caching to avoid rebuilding when the array reference is stable.
 */
let _prevEffectiveEvents: ReadonlyArray<unknown> = [];
let _prevEffectiveIndexMap = new Map<string, number>();

/** Release the previous session's replay-index inputs on session departure. */
export function resetContextAtomMemoCaches(): void {
  _prevEffectiveEvents = [];
  _prevEffectiveIndexMap = new Map<string, number>();
}

const effectiveEventIndexMapAtom = atom((get) => {
  const events = get(effectiveEventsAtom);
  if (events === _prevEffectiveEvents) return _prevEffectiveIndexMap;
  _prevEffectiveEvents = events;
  const map = new Map<string, number>();
  for (let i = 0; i < events.length; i++) {
    map.set(events[i].id, i);
  }
  _prevEffectiveIndexMap = map;
  return map;
});
effectiveEventIndexMapAtom.debugLabel = "session/effectiveEventIndexMap";

/**
 * Navigate to event with thread-aware slider calculation.
 * Uses effectiveTimeRange for correct slider position.
 */
export const navigateToEventInContextAtom = atom(
  null,
  (get, set, eventId: string) => {
    const index = get(eventIndexAtom);
    const event = index.get(eventId);

    if (!event) return;

    set(currentEventIdAtom, eventId);
    set(replayModeAtom, "replay" as ReplayMode);

    // Use effective time range for slider calculation
    const range = get(effectiveTimeRangeAtom);
    if (range.start && range.end) {
      const startMs = new Date(range.start).getTime();
      const endMs = new Date(range.end).getTime();
      const eventMs = new Date(event.createdAt).getTime();
      const rangeMs = endMs - startMs;

      if (rangeMs > 0) {
        // Clamp to 0-200 range
        const value = ((eventMs - startMs) / rangeMs) * REPLAY_CONFIG.MAX_VALUE;
        set(
          replayBarValueAtom,
          Math.max(0, Math.min(REPLAY_CONFIG.MAX_VALUE, value))
        );
      }
    }
  }
);
navigateToEventInContextAtom.debugLabel = "session/navigateToEventInContext";

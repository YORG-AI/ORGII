/**
 * Session Core Module
 *
 * Core types and atoms for session state management.
 */

// Types
export type {
  ActivityStatus,
  CachedSession,
  EventDisplayStatus,
  EventDisplayVariant,
  ReplayMode,
  ReplayTimeRange,
  SessionEvent,
  SessionLoadStatus,
  SessionSpec,
} from "./types";

// Core Atoms
export {
  eventIndexAtom,
  eventsAtom,
  eventStoreVersionAtom,
  sortedEventsAtom,
} from "./atoms";

// Event Store (Rust-backed proxy)
export { eventStore, eventStoreProxy } from "./store";
export type {
  DerivedSnapshot,
  StreamingSnapshot,
  Snapshot,
  EventStoreProxy,
} from "./store";
export { useEventStoreSelector } from "./store";

// Replay Atoms
export {
  currentEventAtom,
  currentEventIdAtom,
  currentEventIndexAtom,
  replayBarValueAtom,
  replayModeAtom,
  replayTimeRangeAtom,
  replayTimeRangeValidAtom,
} from "./atoms";

// Metadata Atoms
export {
  hasMoreEventsAtom,
  isFromCacheAtom,
  isLoadingMoreAtom,
  lastFetchedAtom,
  loadErrorAtom,
  loadStatusAtom,
  sessionIdAtom,
  sessionReloadEpochMapAtom,
  triggerSessionReloadAtom,
  sessionHydrationCountMapAtom,
  sessionHydrationByIdAtom,
  beginSessionHydrationAtom,
  endSessionHydrationAtom,
  specsAtom,
} from "./atoms";
export type { SessionHydrationState } from "./atoms";

// Action Atoms
export {
  appendEventsAtom,
  clearSessionAtom,
  clearSessionLoadErrorAtom,
  failSessionLoadAtom,
  goLiveAtom,
  loadSessionAtom,
  navigateNextAtom,
  navigatePrevAtom,
  navigateToEventAtom,
  updateEventAtom,
  updateEventByIdAtom,
  updateEventByPredicateAtom,
} from "./atoms";

// Context-Aware Atoms (Thread filtered) - Internal use only
export {
  effectiveEventsAtom,
  effectiveTimeRangeAtom,
  navigateToEventInContextAtom,
  threadFilteredEventsAtom,
} from "./atoms";

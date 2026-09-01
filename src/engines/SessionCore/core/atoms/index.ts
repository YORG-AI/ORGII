/**
 * Session Core Atoms - Index
 *
 * Re-exports all atoms from split files.
 */

// Core Event Store
export {
  eventsAtom,
  eventCountAtom,
  hasReplayableEventsAtom,
  eventStoreVersionAtom,
  editTruncationTimestampAtom,
  eventIndexAtom,
  eventSecondaryLookupAtom,
  sortedEventsAtom,
  sortedEventIndexMapAtom,
  streamingDeltaContentAtom,
} from "./events";
export type { StreamingDeltaContent, StreamingDeltaKind } from "./events";

// Replay State
export {
  currentEventIdAtom,
  currentEventAtom,
  currentEventIndexAtom,
  replayBarValueAtom,
  replayTimeRangeAtom,
  replayTimeRangeValidAtom,
  replayModeAtom,
} from "./replay";

// Session Metadata
export {
  sessionIdAtom,
  loadStatusAtom,
  loadErrorAtom,
  sessionReloadEpochMapAtom,
  triggerSessionReloadAtom,
  sessionHydrationCountMapAtom,
  sessionHydrationByIdAtom,
  beginSessionHydrationAtom,
  endSessionHydrationAtom,
  isFromCacheAtom,
  lastFetchedAtom,
  hasMoreEventsAtom,
  isLoadingMoreAtom,
  pendingSyntheticEventAtom,
  specsAtom,
} from "./metadata";
export type { SessionHydrationState } from "./metadata";

// Compound Actions
export {
  clearSessionAtom,
  clearSessionLoadErrorAtom,
  failSessionLoadAtom,
  loadSessionAtom,
  appendEventsAtom,
  updateEventAtom,
  updateEventByIdAtom,
  updateEventByPredicateAtom,
  navigateToEventAtom,
  navigateNextAtom,
  navigatePrevAtom,
  goLiveAtom,
} from "./actions";

// Context-Aware (Thread filtered) - Internal use only
export { threadFilteredEventsAtom, effectiveEventsAtom } from "./context";

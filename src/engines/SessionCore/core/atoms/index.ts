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
  streamingDeltaContentAtom,
} from "./events";
export type { StreamingDeltaContent } from "./events";

// Replay State
export {
  currentEventIdAtom,
  currentEventAtom,
  replayBarValueAtom,
  replayTimeRangeAtom,
  replayModeAtom,
} from "./replay";

// Session Metadata
export {
  sessionIdAtom,
  loadStatusAtom,
  loadErrorAtom,
  sessionReloadEpochMapAtom,
  triggerSessionReloadAtom,
  sessionHydrationByIdAtom,
  beginSessionHydrationAtom,
  endSessionHydrationAtom,
  pendingSyntheticEventAtom,
  specsAtom,
} from "./metadata";

// Compound Actions
export {
  clearSessionAtom,
  clearSessionLoadErrorAtom,
  failSessionLoadAtom,
  loadSessionAtom,
  updateEventByIdAtom,
  navigateToEventAtom,
  navigateNextAtom,
  navigatePrevAtom,
  goLiveAtom,
} from "./actions";

// Context-Aware (Thread filtered) - Internal use only
export { threadFilteredEventsAtom, effectiveEventsAtom } from "./context";

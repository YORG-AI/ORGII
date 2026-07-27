/**
 * Replay navigation atoms (Write-only): move the current event pointer
 * forward/back, jump to a specific event, or return to live-follow mode.
 *
 * Extracted from actions.ts.
 */
import { atom } from "jotai";

import { REPLAY_CONFIG } from "@src/config/workspace/replayConfig";

import { isSimulatorVisibleApprox } from "./actions.simulatorPreview";
import { navigateToEventAndUpdateBar } from "./actionsUtils";
import { eventIndexAtom, sortedEventsAtom } from "./events";
import {
  currentEventIdAtom,
  currentEventIndexAtom,
  replayBarValueAtom,
  replayModeAtom,
} from "./replay";

/**
 * Navigate to a specific event by ID.
 */
export const navigateToEventAtom = atom(null, (get, set, eventId: string) => {
  const index = get(eventIndexAtom);
  const event = index.get(eventId);
  if (event) {
    navigateToEventAndUpdateBar(get, set, event);
  }
});
navigateToEventAtom.debugLabel = "session/navigateToEvent";

/**
 * Navigate to next event.
 */
export const navigateNextAtom = atom(null, (get, set) => {
  const currentIndex = get(currentEventIndexAtom);
  const sorted = get(sortedEventsAtom);

  if (currentIndex < sorted.length - 1) {
    navigateToEventAndUpdateBar(get, set, sorted[currentIndex + 1]);
  }
});
navigateNextAtom.debugLabel = "session/navigateNext";

/**
 * Navigate to previous event.
 */
export const navigatePrevAtom = atom(null, (get, set) => {
  const currentIndex = get(currentEventIndexAtom);
  const sorted = get(sortedEventsAtom);

  if (currentIndex > 0) {
    navigateToEventAndUpdateBar(get, set, sorted[currentIndex - 1]);
  }
});
navigatePrevAtom.debugLabel = "session/navigatePrev";

/**
 * Switch to live mode (follow latest).
 */
export const goLiveAtom = atom(null, (get, set) => {
  const sorted = get(sortedEventsAtom);

  set(replayModeAtom, "follow");
  set(replayBarValueAtom, REPLAY_CONFIG.MAX_VALUE);

  if (sorted.length > 0) {
    // Prefer the last simulator-visible event so the center
    // doesn't land on an unrenderable session_end
    let target = sorted[sorted.length - 1];
    for (let idx = sorted.length - 1; idx >= 0; idx--) {
      if (isSimulatorVisibleApprox(sorted[idx])) {
        target = sorted[idx];
        break;
      }
    }
    set(currentEventIdAtom, target.id);
  }
});
goLiveAtom.debugLabel = "session/goLive";

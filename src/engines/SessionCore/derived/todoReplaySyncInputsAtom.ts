import { atom } from "jotai";

import { currentEventAtom } from "../core/atoms";
import { eventsAtom } from "../core/atoms/events";
import { sessionIdAtom } from "../core/atoms/metadata";
import type { SessionEvent } from "../core/types";
import { simulatorEventsAtom } from "./simulatorEvents";

/**
 * Bundles the replay/live inputs that drive todo pin-bar sync.
 *
 * Subscribing to this atom instead of each source atom separately means
 * Jotai emits one notification per dependency batch instead of up to four.
 */
export interface TodoReplaySyncInputs {
  pipelineSessionId: string | null;
  liveEvents: readonly SessionEvent[];
  simulatorEvents: readonly SessionEvent[];
  currentEvent: SessionEvent | null;
}

export const todoReplaySyncInputsAtom = atom<TodoReplaySyncInputs>((get) => ({
  pipelineSessionId: get(sessionIdAtom),
  liveEvents: get(eventsAtom),
  simulatorEvents: get(simulatorEventsAtom),
  currentEvent: get(currentEventAtom),
}));

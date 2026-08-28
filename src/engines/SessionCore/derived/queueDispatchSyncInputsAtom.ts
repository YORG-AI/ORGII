import { atom } from "jotai";

import {
  type QueuedMessage,
  messageQueueAtom,
  messageQueueHydratedAtom,
  queueEditingAtom,
  queueFlushRequestAtom,
} from "@src/store/ui/messageQueueAtom";

import { turnLifecycleSignalAtom } from "../control/turnLifecycle";

/**
 * Bundles the inputs that drive the singleton queue dispatcher.
 *
 * Subscribing to this atom instead of each source atom separately means
 * Jotai emits one notification per dependency batch instead of up to five.
 */
export interface QueueDispatchSyncInputs {
  queue: QueuedMessage[];
  hydrated: boolean;
  turnLifecycleSignal: number;
  flushRequest: number;
  editing: boolean;
}

export const queueDispatchSyncInputsAtom = atom<QueueDispatchSyncInputs>(
  (get) => ({
    queue: get(messageQueueAtom),
    hydrated: get(messageQueueHydratedAtom),
    turnLifecycleSignal: get(turnLifecycleSignalAtom),
    flushRequest: get(queueFlushRequestAtom),
    editing: get(queueEditingAtom),
  })
);

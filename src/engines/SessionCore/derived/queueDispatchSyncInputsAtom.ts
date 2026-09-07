import { atom } from "jotai";

import {
  type MessageDeliveryRecord,
  messageDeliveryRecordsAtom,
  messageQueueHydratedAtom,
  queueEditingAtom,
} from "@src/store/ui/messageQueueAtom";

import { turnLifecycleSignalAtom } from "../control/turnLifecycle";

/**
 * Bundles the inputs that drive the singleton queue dispatcher.
 *
 * Subscribing to this atom instead of each source atom separately means
 * Jotai emits one notification per dependency batch instead of up to five.
 */
export interface QueueDispatchSyncInputs {
  deliveries: MessageDeliveryRecord[];
  queueHydrated: boolean;
  turnLifecycleSignal: number;
  editing: boolean;
}

export const queueDispatchSyncInputsAtom = atom<QueueDispatchSyncInputs>(
  (get) => ({
    deliveries: get(messageDeliveryRecordsAtom),
    queueHydrated: get(messageQueueHydratedAtom),
    turnLifecycleSignal: get(turnLifecycleSignalAtom),
    editing: get(queueEditingAtom),
  })
);

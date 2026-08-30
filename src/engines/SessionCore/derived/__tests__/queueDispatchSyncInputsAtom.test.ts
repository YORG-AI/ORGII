import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";

import {
  messageQueueHydratedAtom,
  queueFlushRequestAtom,
} from "@src/store/ui/messageQueueAtom";

import { turnLifecycleSignalAtom } from "../../control/turnLifecycle";
import { queueDispatchSyncInputsAtom } from "../queueDispatchSyncInputsAtom";

describe("queueDispatchSyncInputsAtom", () => {
  it("bundles queue dispatch inputs", () => {
    const store = createStore();

    store.set(messageQueueHydratedAtom, true);
    store.set(queueFlushRequestAtom, 2);
    store.set(turnLifecycleSignalAtom, 7);

    expect(store.get(queueDispatchSyncInputsAtom)).toMatchObject({
      queue: [],
      hydrated: true,
      turnLifecycleSignal: 7,
      flushRequest: 2,
      editing: false,
    });
  });

  it("notifies subscribers once per bundled source change", () => {
    const store = createStore();
    const listener = vi.fn();

    store.sub(queueDispatchSyncInputsAtom, listener);
    listener.mockClear();

    store.set(messageQueueHydratedAtom, true);
    expect(listener).toHaveBeenCalledTimes(1);

    store.set(turnLifecycleSignalAtom, 1);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

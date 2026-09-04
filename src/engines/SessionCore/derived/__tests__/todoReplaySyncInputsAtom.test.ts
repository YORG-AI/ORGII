import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";

import { sessionIdAtom } from "../../core/atoms/metadata";
import { todoReplaySyncInputsAtom } from "../todoReplaySyncInputsAtom";

describe("todoReplaySyncInputsAtom", () => {
  it("bundles pipeline session and replay inputs", () => {
    const store = createStore();

    store.set(sessionIdAtom, "session-a");

    expect(store.get(todoReplaySyncInputsAtom)).toMatchObject({
      pipelineSessionId: "session-a",
      liveEvents: [],
      simulatorEvents: [],
      currentEvent: null,
    });
  });

  it("notifies subscribers once per bundled source change", () => {
    const store = createStore();
    const listener = vi.fn();

    store.sub(todoReplaySyncInputsAtom, listener);
    listener.mockClear();

    store.set(sessionIdAtom, "session-a");
    expect(listener).toHaveBeenCalledTimes(1);

    store.set(sessionIdAtom, "session-b");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

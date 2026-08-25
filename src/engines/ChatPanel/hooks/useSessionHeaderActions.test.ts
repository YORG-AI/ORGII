// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { derivedSnapshotAtom } from "@src/engines/SessionCore/core/atoms/events";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { useSessionHeaderActions } from "./useSessionHeaderActions";

const dropdownMocks = vi.hoisted(() => ({
  close: vi.fn(),
  toggle: vi.fn(),
}));

vi.mock("@src/hooks/dropdown", () => ({
  useDropdownEngine: () => ({
    isOpen: false,
    isPositioned: false,
    toggle: dropdownMocks.toggle,
    close: dropdownMocks.close,
    triggerRef: { current: null },
    panelRef: { current: null },
    panelPosition: { left: 0, top: 0, width: 0, maxHeight: 0 },
  }),
}));

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

type HeaderActions = ReturnType<typeof useSessionHeaderActions>;

let actions: HeaderActions | null = null;
const onReady = vi.fn((value: HeaderActions) => {
  actions = value;
});

function Harness({ onActions }: { onActions: (value: HeaderActions) => void }) {
  const value = useSessionHeaderActions({ handleReloadSession: vi.fn() });
  useEffect(() => onActions(value), [onActions, value]);
  return null;
}

function event(id: string, displayText: string): SessionEvent {
  return {
    chunk_id: id,
    id,
    sessionId: "session-1",
    createdAt: "2026-08-24T00:00:00.000Z",
    functionName: "assistant_message",
    uiCanonical: "assistant_message",
    actionType: "assistant",
    args: {},
    result: { text: displayText },
    source: "assistant",
    displayText,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
  };
}

function snapshot(events: SessionEvent[]) {
  return {
    version: 1,
    eventCount: events.length,
    events,
    chatEvents: events,
    messagesEvents: [],
    sortedSimulatorEvents: events,
    lastEvent: events[events.length - 1] ?? null,
    eventIndex: {},
    chatEventCount: events.length,
    hasRunningEvent: false,
  };
}

describe("useSessionHeaderActions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;
  const writeText = vi.fn<() => Promise<void>>();
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    actions = null;
    store = createStore();
    store.set(
      derivedSnapshotAtom,
      snapshot([event("event-1", "Initial text")]) as never
    );
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(Harness, { onActions: onReady })
        )
      );
    });
  });

  afterEach(() => {
    if (root) act(() => root.unmount());
    container?.remove();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("reads the latest events on demand without subscribing to event updates", async () => {
    const latestEvents = [event("event-2", "Latest streamed text")];
    const rendersBeforeEventUpdate = onReady.mock.calls.length;

    act(() => store.set(derivedSnapshotAtom, snapshot(latestEvents) as never));

    expect(onReady).toHaveBeenCalledTimes(rendersBeforeEventUpdate);

    await act(async () => {
      actions?.handleCopyEventJson();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(
      JSON.stringify(latestEvents, null, 2)
    );
    expect(dropdownMocks.close).toHaveBeenCalledOnce();
    expect(actions?.copyEventJsonLabel).toBe("copied");

    act(() => vi.advanceTimersByTime(2_000));
    expect(actions?.copyEventJsonLabel).toBe("idle");
  });
});

// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { createElement } from "react";
import { act } from "react";
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

import { eventsAtom } from "@src/engines/SessionCore/core/atoms/events";
import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms/metadata";
import { useEventStoreBridge } from "@src/engines/SessionCore/core/store/useEventStoreBridge";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

const mocks = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  subscribe: vi.fn(),
  detachTauri: vi.fn(),
  getLatestSessionSnapshot: vi.fn(() => null),
}));

const actEnvironment = globalThis as {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
beforeAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
});

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    init: mocks.init,
    subscribe: mocks.subscribe,
    detachTauri: mocks.detachTauri,
    getLatestSessionSnapshot: mocks.getLatestSessionSnapshot,
  },
  isStreamingSnapshot: () => false,
}));

function event(id: string): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId: "codexapp-visible",
    createdAt: "2026-07-22T00:00:00.000Z",
    functionName: "assistant",
    uiCanonical: "assistant",
    actionType: "raw",
    args: {},
    result: {},
    source: "assistant",
    displayText: id,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
  };
}

function snapshot(version: number, events: SessionEvent[]) {
  return {
    version,
    eventCount: events.length,
    events,
    chatEvents: events,
    messagesEvents: events,
    sortedSimulatorEvents: events,
    lastEvent: events.at(-1) ?? null,
    eventIndex: Object.fromEntries(events.map((row, index) => [row.id, index])),
    chatEventCount: events.length,
    hasRunningEvent: false,
  };
}

function BridgeHarness() {
  useEventStoreBridge();
  return null;
}

describe("external replay EventStore bridge", () => {
  let root: Root;
  let container: HTMLDivElement;
  let listener: ((value: unknown, sessionId: string) => void) | null;

  beforeEach(() => {
    vi.clearAllMocks();
    listener = null;
    mocks.subscribe.mockImplementation((next) => {
      listener = next;
      return vi.fn();
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("projects Rust replay upserts, removals and resets into the visible atoms", async () => {
    const store = createStore();
    store.set(sessionIdAtom, "codexapp-visible");
    await act(async () => {
      root.render(
        createElement(Provider, { store }, createElement(BridgeHarness))
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listener).not.toBeNull();

    const first = event("event-old");
    await act(async () => {
      listener?.(snapshot(1, [first]), "codexapp-visible");
    });
    expect(store.get(eventsAtom).map((row) => row.id)).toEqual(["event-old"]);

    // This is the full snapshot emitted after Rust atomically applies a
    // replay delta/reset: old id removed, new id upserted. No JS→Rust write is
    // needed for the visible projection to converge.
    const replacement = event("event-new");
    await act(async () => {
      listener?.(snapshot(2, [replacement]), "codexapp-visible");
    });
    expect(store.get(eventsAtom).map((row) => row.id)).toEqual(["event-new"]);
  });
});

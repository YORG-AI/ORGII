import { createStore } from "jotai/vanilla";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { eventStoreProxy } from "../../store/EventStoreProxy";
import type { SessionEvent } from "../../types";
import type {
  appendEventsAtom as AppendEventsAtomType,
  loadSessionAtom as LoadSessionAtomType,
} from "../actions";
import type { eventsAtom as EventsAtomType } from "../events";

vi.mock("../../store/EventStoreProxy", () => ({
  eventStoreProxy: {
    append: vi.fn().mockResolvedValue(undefined),
    mergeEvents: vi.fn().mockResolvedValue(undefined),
    removeSyntheticUserInputEvents: vi.fn().mockResolvedValue(0),
    scheduleSessionSnapshotRelease: vi.fn(),
    cancelScheduledSnapshotRelease: vi.fn(),
  },
}));

const localStorageStore = new Map<string, string>();

vi.stubGlobal("localStorage", {
  getItem: (key: string) => localStorageStore.get(key) ?? null,
  setItem: (key: string, value: string) => {
    localStorageStore.set(key, value);
  },
  removeItem: (key: string) => {
    localStorageStore.delete(key);
  },
  clear: () => {
    localStorageStore.clear();
  },
});

let appendEventsAtom: typeof AppendEventsAtomType;
let loadSessionAtom: typeof LoadSessionAtomType;
let eventsAtom: typeof EventsAtomType;

beforeAll(async () => {
  ({ appendEventsAtom, loadSessionAtom } = await import("../actions"));
  ({ eventsAtom } = await import("../events"));
});

beforeEach(() => {
  vi.mocked(eventStoreProxy.append).mockClear();
  vi.mocked(eventStoreProxy.mergeEvents).mockClear();
  vi.mocked(eventStoreProxy.removeSyntheticUserInputEvents).mockClear();
  vi.mocked(eventStoreProxy.scheduleSessionSnapshotRelease).mockClear();
  vi.mocked(eventStoreProxy.cancelScheduledSnapshotRelease).mockClear();
});

function makeMessageEvent(
  id: string,
  sessionId = "session-1",
  createdAt = "2026-05-16T00:00:00.000Z"
): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId,
    createdAt,
    functionName: id.startsWith("user") ? "user_message" : "message",
    uiCanonical: id.startsWith("user") ? "user_message" : "message",
    actionType: id.startsWith("user") ? "raw" : "message",
    args: {},
    result: id.startsWith("user") ? { message: { content: id } } : {},
    source: id.startsWith("user") ? "user" : "assistant",
    displayText: id,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
  };
}

function makeUserMessageEvent(
  id: string,
  content: string,
  options: { images?: string[]; synthetic?: boolean } = {}
): SessionEvent {
  const event = makeMessageEvent(id);
  return {
    ...event,
    displayText: content,
    result: {
      message: { content },
      ...(options.images ? { images: options.images } : {}),
      ...(options.synthetic ? { syntheticUserInput: true } : {}),
    },
  };
}

describe("loadSessionAtom", () => {
  it("preserves existing same-session rounds when a later load carries only a new tail event", () => {
    const store = createStore();
    const existingEvents = [
      makeMessageEvent("user-round-1", "session-1", "2026-05-16T00:00:01.000Z"),
      makeMessageEvent(
        "assistant-round-1",
        "session-1",
        "2026-05-16T00:00:02.000Z"
      ),
      makeMessageEvent("user-round-2", "session-1", "2026-05-16T00:00:03.000Z"),
      makeMessageEvent(
        "assistant-round-2",
        "session-1",
        "2026-05-16T00:00:04.000Z"
      ),
      makeMessageEvent("user-round-3", "session-1", "2026-05-16T00:00:05.000Z"),
    ];
    const followup = makeMessageEvent(
      "user-round-4",
      "session-1",
      "2026-05-16T00:00:06.000Z"
    );

    store.set(loadSessionAtom, {
      sessionId: "session-1",
      events: existingEvents,
    });
    store.set(loadSessionAtom, { sessionId: "session-1", events: [followup] });

    expect(store.get(eventsAtom).map((event) => event.id)).toEqual([
      "user-round-1",
      "assistant-round-1",
      "user-round-2",
      "assistant-round-2",
      "user-round-3",
      "user-round-4",
    ]);
  });

  it("preserves existing same-session history when a later load has equal or more events", () => {
    const store = createStore();
    const existingEvents = [
      makeMessageEvent("user-round-1", "session-1", "2026-05-16T00:00:01.000Z"),
      makeMessageEvent(
        "assistant-round-1",
        "session-1",
        "2026-05-16T00:00:02.000Z"
      ),
    ];
    const nextEvents = [
      makeMessageEvent("user-round-2", "session-1", "2026-05-16T00:00:03.000Z"),
      makeMessageEvent(
        "assistant-round-2",
        "session-1",
        "2026-05-16T00:00:04.000Z"
      ),
    ];

    store.set(loadSessionAtom, {
      sessionId: "session-1",
      events: existingEvents,
    });
    store.set(loadSessionAtom, { sessionId: "session-1", events: nextEvents });

    expect(store.get(eventsAtom).map((event) => event.id)).toEqual([
      "user-round-1",
      "assistant-round-1",
      "user-round-2",
      "assistant-round-2",
    ]);
  });

  it("replaces events when switching to a different session", () => {
    const store = createStore();
    const sessionOneEvents = [makeMessageEvent("user-round-1", "session-1")];
    const sessionTwoEvents = [makeMessageEvent("user-round-1", "session-2")];

    store.set(loadSessionAtom, {
      sessionId: "session-1",
      events: sessionOneEvents,
    });
    store.set(loadSessionAtom, {
      sessionId: "session-2",
      events: sessionTwoEvents,
    });

    expect(store.get(eventsAtom).map((event) => event.sessionId)).toEqual([
      "session-2",
    ]);
    // Switching away schedules the outgoing session's snapshot release;
    // the incoming session is rescued from any pending release.
    expect(eventStoreProxy.scheduleSessionSnapshotRelease).toHaveBeenCalledWith(
      "session-1"
    );
    expect(eventStoreProxy.cancelScheduledSnapshotRelease).toHaveBeenCalledWith(
      "session-2"
    );
  });

  it("carries optimistic user images onto the persisted echo during load", () => {
    const store = createStore();
    const images = ["data:image/png;base64,AAA"];
    const optimistic = makeUserMessageEvent("user-input-1", "see this", {
      images,
      synthetic: true,
    });
    const persisted = makeUserMessageEvent("user-message-1", "see this");

    store.set(loadSessionAtom, {
      sessionId: "session-1",
      events: [optimistic, persisted],
    });

    expect(store.get(eventsAtom)).toHaveLength(1);
    expect(store.get(eventsAtom)[0].id).toBe("user-message-1");
    expect(store.get(eventsAtom)[0].result?.images).toEqual(images);
  });

  it("carries optimistic user images onto a live persisted echo", () => {
    const store = createStore();
    const images = ["data:image/png;base64,BBB"];
    const optimistic = makeUserMessageEvent("user-input-1", "see this", {
      images,
      synthetic: true,
    });
    const persisted = makeUserMessageEvent("user-message-1", "see this");

    store.set(loadSessionAtom, {
      sessionId: "session-1",
      events: [optimistic],
    });
    store.set(appendEventsAtom, [persisted]);

    expect(eventStoreProxy.append).toHaveBeenLastCalledWith([
      expect.objectContaining({
        id: "user-message-1",
        result: expect.objectContaining({ images }),
      }),
    ]);
  });
});
